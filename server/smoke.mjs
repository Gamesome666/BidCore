#!/usr/bin/env node
// BidCore 端到端冒烟（零框架、零依赖，Node 内置 fetch）
//
// 用法：
//   node server/smoke.mjs                 # 打 http://127.0.0.1:5192
//   BIDCORE_BASE=http://127.0.0.1:5197 node server/smoke.mjs
//
// 约定：
//   ✔ 通过 / ✘ 失败 / ↷ 跳过（接口未就绪或无法用公开接口构造条件，原因随行输出）
//   退出码：失败数 > 0 → 1；服务未启动 → 2；全部通过或有跳过 → 0
//   不改任何 domain/routes 代码；所有写操作都走公开 API。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocx } from './lib/docparse/docx.mjs';

const BASE = String(process.env.BIDCORE_BASE || 'http://127.0.0.1:5192').replace(/\/+$/, '');
const WAIT_MS = Number(process.env.BIDCORE_SMOKE_WAIT_MS || 120_000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Skip extends Error {
  constructor(reason) { super(reason); this.name = 'Skip'; }
}
const skip = (reason) => { throw new Skip(reason); };

const stats = { pass: 0, fail: 0, skip: 0 };
const failures = [];
const skipNotes = [];
const tokens = {};
let token = '';

function line(symbol, title, detail) {
  console.log(`${symbol} ${title}${detail ? ` — ${detail}` : ''}`);
}

async function check(title, fn) {
  const started = Date.now();
  try {
    const evidence = await fn();
    stats.pass += 1;
    line('✔', title, `${evidence === undefined ? 'ok' : evidence} (${Date.now() - started}ms)`);
  } catch (error) {
    if (error instanceof Skip) {
      stats.skip += 1;
      skipNotes.push({ title, reason: error.message });
      line('↷', title, `skip: ${error.message}`);
      return;
    }
    stats.fail += 1;
    const message = error?.message || String(error);
    failures.push({ title, message });
    line('✘', title, message);
  }
}

/**
 * 统一请求。
 * @returns {{status:number,data:any,buf:Buffer|null,headers:Headers}}
 */
async function api(method, path, { body, auth, headers = {}, timeout = 90_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const useToken = auth === undefined ? token : auth;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const type = res.headers.get('content-type') || '';
    let data = null;
    let buf = null;
    if (type.includes('application/json')) {
      const text = await res.text();
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    } else {
      buf = Buffer.from(await res.arrayBuffer());
      const text = buf.toString('utf8');
      try { data = text ? JSON.parse(text) : null; } catch { data = text.slice(0, 400); }
    }
    return { status: res.status, data, buf, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

/** 路由未实现 → 跳过；其它 HTTP 状态 → 失败（不做断言放宽） */
function ensureImplemented(res, label) {
  if (res.status === 404 && (res.data?.code === 'NOT_FOUND' || /接口不存在/.test(String(res.data?.error || '')))) {
    skip(`${label} 尚未实现（404）`);
  }
  if (res.status === 501 || res.status === 503) skip(`${label} 未就绪（${res.status}）`);
  return res;
}

function must(res, expect, label) {
  ensureImplemented(res, label);
  const statuses = Array.isArray(expect) ? expect : [expect];
  assert.ok(
    statuses.includes(res.status),
    `${label} 期望 ${statuses.join('/')}，实际 ${res.status} ${JSON.stringify(res.data)?.slice(0, 300)}`,
  );
  return res.data;
}

async function waitFor(label, predicate, timeout = WAIT_MS, interval = 500) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await predicate();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`等待超时 ${Math.round(timeout / 1000)}s：${label}${last ? `（最后状态 ${JSON.stringify(last)?.slice(0, 200)}）` : ''}`);
}

const projectName = (p) => String(p?.name || '');
const pendingReviews = async (runId) =>
  (await api('GET', '/api/reviews?status=pending')).data.filter((r) => r.run_id === runId);

async function waitRun(runId, statuses, timeout = WAIT_MS) {
  return waitFor(`run ${runId.slice(0, 14)} 进入 ${statuses.join('/')}`, async () => {
    const { data } = await api('GET', `/api/runs/${runId}`);
    if (!data?.run) return null;
    return statuses.includes(data.run.status) ? data : null;
  }, timeout, 600);
}

async function planStep(projectId, step, options = {}) {
  const res = await api('POST', `/api/projects/${projectId}/technical-plan/steps`, { body: { step, options }, timeout: 120_000 });
  ensureImplemented(res, `technical-plan/steps(${step})`);
  if (res.status !== 200) {
    throw new Error(`步骤 ${step} 失败：${res.status} ${JSON.stringify(res.data)?.slice(0, 300)}`);
  }
  const task = res.data?.task;
  assert.equal(task?.status, 'success', `步骤 ${step} 任务未成功：${task?.status} ${task?.error || ''}`);
  return res.data;
}

/* ── 知识库上传：multipart 请求 + 最小 DOCX/PNG 构造（零依赖） ─────────── */

// 附件根目录与 server/db.mjs 的 VAR_DIR 一致（BIDCORE_DB 只改数据库位置，不改附件目录）
const FILES_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'var', 'files', 'knowledge');
const EXPORT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'var', 'files');
const UPLOAD_LIBRARY = 'doc';
const DOCX_KEYWORD = '冒烟抽取关键词-知识库上传';
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 写一个 store（method=0）压缩的 zip，够 docx 解析用，也避免依赖 zlib */
function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

const xmlEsc = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** 构造带标题、正文和表格的最小 docx（与 docparse/docx.mjs 的 w:p / w:tbl 约定一致） */
function makeDocx() {
  const p = (text, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}<w:r><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
  const table = [
    ['交付项', '周期'],
    ['等保整改台账', '30 天'],
  ].map((cells) => `<w:tr>${cells.map((cell) => `<w:tc><w:p><w:r><w:t>${xmlEsc(cell)}</w:t></w:r></w:p></w:tc>`).join('')}</w:tr>`).join('');
  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + p('智慧园区运维方案', 'Heading1')
    + p(DOCX_KEYWORD)
    + p('本方案覆盖 7x24 值守、等保三级整改与应急演练。')
    + `<w:tbl>${table}</w:tbl>`
    + '</w:body></w:document>';
  return buildZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>',
    'word/document.xml': documentXml,
  });
}

/** 构造一份「像招标文件」的长 docx（项目级上传要求正文 ≥200 字） */
function makeTenderDocx() {
  const p = (text) => `<w:p><w:r><w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r></w:p>`;
  const clauses = [
    '投标人须具备 ISO9001 质量管理体系认证，且在有效期内。',
    '投标人须提供 7×24 小时运维服务，一般故障 30 分钟响应。',
    '项目团队须配置项目经理 1 名、系统工程师 2 名，驻场服务。',
    '投标人须提交近三年同类项目业绩，合同金额不低于 300 万元。',
    '质保期自终验合格之日起 36 个月，质保期内免费升级与故障修复。',
    '投标保证金人民币 60,000.00 元，须于投标截止时间前到账。',
  ];
  const body = Array.from({ length: 10 }, (_, i) => p(`3.${i + 1} ${clauses[i % clauses.length]}`)).join('');
  const documentXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + p('冒烟招标文件（演示用）') + body + '</w:body></w:document>';
  return buildZip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
      + '</Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
      + '</Relationships>',
    'word/document.xml': documentXml,
  });
}

/** multipart 上传（不能复用 api()：后者固定发 JSON） */
async function upload(pathname, formData, { auth } = {}) {
  const useToken = auth === undefined ? token : auth;
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: useToken ? { Authorization: `Bearer ${useToken}` } : {},
    body: formData,
  });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json')
    ? await res.json()
    : Buffer.from(await res.arrayBuffer());
  return { status: res.status, data, headers: res.headers };
}

const fileForm = (name, data, mime) => {
  const form = new FormData();
  form.append('files', new Blob([data], { type: mime }), name);
  return form;
};

/* ═════════════════════════════ 0. 预检 ═════════════════════════════ */

console.log(`\nBidCore 端到端冒烟 — ${BASE}\n`);

{
  let health = null;
  try {
    health = await api('GET', '/api/health', { timeout: 4000 });
  } catch (error) {
    console.error(`✘ 无法连接 ${BASE}：${error.message}`);
    console.error('  请先启动服务：cd bidcore && node server/index.mjs（默认 5192）');
    console.error('  或指定地址：BIDCORE_BASE=http://127.0.0.1:5197 node server/smoke.mjs');
    process.exit(2);
  }
  if (health.status !== 200) {
    console.error(`✘ ${BASE}/api/health 返回 ${health.status}（不是 BidCore 服务？）`);
    process.exit(2);
  }
  console.log(`  服务健康：${JSON.stringify(health.data)}\n`);
}

/* ═════════════════════════════ 1. 账号与基础读取 ═════════════════════════════ */

const ACCOUNTS = [
  ['admin', 'admin123', 'admin'],
  ['owner', 'owner123', 'user'],
  ['tech', 'tech123', 'user'],
  ['biz', 'biz123', 'user'],
  ['reviewer', 'reviewer123', 'user'],
];

await check('5 个演示账号登录', async () => {
  for (const [username, password, role] of ACCOUNTS) {
    const res = await api('POST', '/api/auth/login', { body: { username, password }, auth: '' });
    assert.equal(res.status, 200, `${username} 登录失败：${JSON.stringify(res.data)}`);
    assert.ok(res.data.token, `${username} 未返回 token`);
    assert.equal(res.data.user.username, username);
    assert.equal(res.data.user.role, role, `${username} 角色异常`);
    tokens[username] = res.data.token;
  }
  token = tokens.admin;
  return `admin/owner/tech/biz/reviewer 全部拿到 token`;
});

await check('/api/me 返回当前用户与模块', async () => {
  const data = must(await api('GET', '/api/me'), 200, '/api/me');
  assert.equal(data.user.username, 'admin');
  assert.equal(data.user.role, 'admin');
  assert.ok(Array.isArray(data.user.modules), 'modules 应为数组');
  return `${data.user.display_name} · ${data.user.role} · modules=${data.user.modules.length}`;
});

let projectId = 0;
let project = null;
let projects = [];

await check('项目列表 / 详情 / 招标原文', async () => {
  projects = must(await api('GET', '/api/projects'), 200, '/api/projects');
  assert.ok(Array.isArray(projects) && projects.length >= 2, `项目数 ${projects?.length}`);
  const cloud = projects.find((p) => p.name.includes('政务云')) || projects[0];
  projectId = cloud.id;
  project = must(await api('GET', `/api/projects/${projectId}`), 200, '/api/projects/:id');
  assert.equal(project.id, projectId);
  assert.ok(Number(project.tender_chars) > 1000, `招标文本 ${project.tender_chars} 字`);
  assert.ok(project.owner?.username, '缺少 owner');
  const tender = must(await api('GET', `/api/projects/${projectId}/tender`), 200, '/api/projects/:id/tender');
  assert.ok(String(tender.text).length > 1000);
  return `${projects.length} 个项目 / 当前 #${projectId}「${projectName(project)}」/ ${project.tender_chars} 字`;
});

await check('项目工作台快照 /workspace', async () => {
  const data = must(await api('GET', `/api/projects/${projectId}/workspace`), 200, '/workspace');
  assert.equal(data.project.id, projectId);
  assert.ok(data.state && typeof data.state.step === 'string', 'state.step 缺失');
  assert.ok(data.state.bid_analysis && data.state.outline && data.state.content, 'state 结构不完整');
  assert.ok('checks' in data && 'exports' in data && Array.isArray(data.pending_reviews));
  return `step=${data.state.step} / 待审 ${data.pending_reviews.length} / 导出 ${data.exports.length}`;
});

/* ═════════════════════════════ 2. 技术方案六步流水线 ═════════════════════════════ */

await check('技术方案状态 GET（结构完整）', async () => {
  const res = await api('GET', `/api/projects/${projectId}/technical-plan`);
  ensureImplemented(res, 'GET /api/projects/:id/technical-plan');
  const data = must(res, 200, 'technical-plan');
  for (const key of ['bid_analysis', 'outline', 'global_facts', 'content', 'checks', 'deviation', 'export', 'step']) {
    assert.ok(key in data, `缺少字段 ${key}`);
  }
  return `step=${data.step} / requirements=${data.bid_analysis.requirements.length}`;
});

await check('技术方案步骤 1/7 parse（要求 ≥12 条）', async () => {
  const data = await planStep(projectId, 'parse');
  const requirements = data.state?.bid_analysis?.requirements || [];
  assert.ok(requirements.length >= 12, `requirements=${requirements.length} < 12`);
  const legacy = data.state?.analysisRaw?.requirements || [];
  assert.ok(legacy.length >= 12, `analysisRaw.requirements=${legacy.length}`);
  const veto = requirements.filter((r) => r.veto).length;
  return `${requirements.length} 条要求（废标 ${veto}）/ step=${data.state.step}`;
});

await check('技术方案步骤 2/7 outline（节点 ≥18）', async () => {
  const data = await planStep(projectId, 'outline');
  const outline = data.state?.outline || {};
  assert.ok((outline.nodes || []).length >= 18, `outline.nodes=${outline.nodes?.length} < 18`);
  assert.ok((outline.leaves || []).length >= 3, `叶子节点 ${outline.leaves?.length}`);
  assert.ok(outline.coverage?.required > 0, 'coverage.required=0');
  return `${outline.nodes.length} 节点 / ${outline.leaves.length} 叶子 / 覆盖 ${outline.coverage.covered}/${outline.coverage.required}`;
});

await check('技术方案步骤 3/7 facts（全局事实）', async () => {
  const data = await planStep(projectId, 'facts');
  const facts = data.state?.global_facts?.facts || [];
  assert.ok(facts.length >= 3, `facts=${facts.length} < 3`);
  assert.ok(facts.every((f) => f.key && f.value), '事实缺 key/value');
  return `${facts.length} 条：${facts.slice(0, 3).map((f) => `${f.key}=${f.value}`).join(' / ')}`;
});

await check('技术方案步骤 4/7 content（≥3 节且正文非空）', async () => {
  const data = await planStep(projectId, 'content');
  const content = data.state?.content || {};
  const sections = content.sections || [];
  assert.ok(sections.length >= 3, `sections=${sections.length} < 3`);
  assert.ok((content.total_words || 0) > 800, `total_words=${content.total_words}`);
  const empty = sections.filter((s) => !String(s.content || '').trim());
  assert.equal(empty.length, 0, `${empty.length} 节正文为空`);
  const short = sections.filter((s) => String(s.content || '').length < 120);
  assert.equal(short.length, 0, `${short.length} 节正文不足 120 字`);
  return `${sections.length} 节 / ${content.total_words} 字 / 最短 ${Math.min(...sections.map((s) => s.words))} 字`;
});

await check('技术方案步骤 5/7 checks（废标 + 查重）', async () => {
  const data = await planStep(projectId, 'checks');
  const checks = data.state?.checks || {};
  assert.equal(checks.rejection?.status, 'success', `rejection=${checks.rejection?.status}`);
  assert.equal(checks.duplicate?.status, 'success', `duplicate=${checks.duplicate?.status}`);
  assert.ok(typeof checks.rejection.veto_count === 'number');
  assert.ok(Number(checks.duplicate.max_similarity) >= 0);
  return `废标项 ${checks.rejection.veto_count} / 最高相似度 ${(Number(checks.duplicate.max_similarity) * 100).toFixed(1)}%`;
});

await check('技术方案步骤 6/7 deviation（生成响应偏离表）', async () => {
  const data = await planStep(projectId, 'deviation');
  const deviation = data.state?.deviation || {};
  assert.ok((deviation.rows || []).length > 0, '偏离表为空');
  assert.equal(deviation.confirmed, false, '新生成的偏离表不应是已确认状态');
  return `${deviation.rows.length} 行（待确认）`;
});

await check('响应偏离表人工确认', async () => {
  const res = await api('POST', `/api/projects/${projectId}/deviation/confirm`, { body: {} });
  ensureImplemented(res, 'POST /deviation/confirm');
  const data = must(res, 200, 'deviation/confirm');
  assert.equal(data.confirmed, true, 'confirmed 未置为 true');
  return `${data.rows?.length ?? data.stats?.total ?? '?'} 行已确认`;
});

let lastExportFile = '';

await check('技术方案步骤 7/7 export（docx > 5000 bytes，validation.ok）', async () => {
  const state = (await api('GET', `/api/projects/${projectId}/technical-plan`)).data;
  if (!state?.deviation?.confirmed) skip('偏离表未确认（确认接口尚未就绪），导出前置校验必然阻断');
  const res = await api('POST', `/api/projects/${projectId}/export`, { body: {}, timeout: 120_000 });
  ensureImplemented(res, 'POST /api/projects/:id/export');
  if (res.status === 409) {
    const blockers = res.data?.validation?.blockers || [];
    throw new Error(`EXPORT_BLOCKED：${blockers.map((b) => b.code || b.label).join(',') || JSON.stringify(res.data)?.slice(0, 200)}`);
  }
  const data = must(res, 200, 'export');
  assert.ok(Number(data.bytes) > 5000, `docx bytes=${data.bytes} <= 5000`);
  assert.equal(data.validation?.ok, true, `validation.ok=${data.validation?.ok} blockers=${JSON.stringify(data.validation?.blockers)}`);
  assert.ok(String(data.file || data.download_url).length > 0, '缺少文件名');
  const download = await api('GET', data.download_url || `/files/${data.file}`, { auth: '' });
  assert.equal(download.status, 200, `下载失败 ${download.status}`);
  const buf = download.buf || Buffer.from(String(download.data));
  assert.ok(buf.length > 5000, `下载字节 ${buf.length}`);
  assert.equal(buf.slice(0, 2).toString(), 'PK', 'docx 不是 zip 容器');
  lastExportFile = data.file;
  const history = must(await api('GET', `/api/projects/${projectId}/exports`), 200, '/exports');
  assert.ok(Array.isArray(history) && history.length >= 1, '导出历史为空');
  return `${data.bytes} bytes / sha=${String(data.sha256).slice(0, 12)} / 历史 ${history.length} 条`;
});

await check('导出文档含「附录C 商务资格与证明材料」（知识库证据链）', async () => {
  if (!lastExportFile) skip('导出未成功，跳过');
  const text = parseDocx(fs.readFileSync(path.join(EXPORT_ROOT, lastExportFile))).text;
  assert.ok(text.includes('附录C 商务资格与证明材料'), '缺少附录C');
  // 有 3.2 条款时是「特定资格逐条响应对照表」，没有时兜底成「企业资质证书清单」，两者都必须有证书编号列
  assert.ok(/(特定资格逐条响应对照表|企业资质证书清单)[\s\S]{0,2000}证书编号/.test(text), '附录C 缺少证书编号列');
  assert.ok(/(ISCCC|ITSS|ISO|CN-|00\d|\b[A-Z]{2,}-[\dA-Z-]{4,})/.test(text), '附录C 未出现任何证书编号');
  const state = must(await api('GET', `/api/projects/${projectId}/technical-plan`), 200, 'technical-plan');
  const refNodes = (state.outline?.nodes || []).filter((n) => (n.refs?.knowledge || []).length);
  assert.ok(refNodes.length >= 1, '目录 refs.knowledge 未写入');
  assert.ok(text.includes('合同金额'), '附录C 缺少业绩金额列');
  return `附录C 在档 / refs.knowledge 节点 ${refNodes.length} 个 / 引用 ${[...new Set(refNodes.flatMap((n) => n.refs.knowledge))].length} 条知识`;
});

await check('解析条目接口 /requirements（含 veto 过滤）', async () => {
  const res = await api('GET', `/api/projects/${projectId}/requirements`);
  ensureImplemented(res, 'GET /requirements');
  const data = must(res, 200, 'requirements');
  assert.ok(data.total >= 12, `total=${data.total}`);
  assert.ok(data.veto_count >= 1, `veto_count=${data.veto_count}`);
  const vetoOnly = must(await api('GET', `/api/projects/${projectId}/requirements?veto=1`), 200, 'requirements?veto=1');
  assert.equal(vetoOnly.requirements.length, data.veto_count, 'veto 过滤数量不一致');
  return `${data.total} 条 / 废标 ${data.veto_count} / 已响应 ${data.responded}`;
});

await check('废标与查重接口 /checks', async () => {
  const res = await api('GET', `/api/projects/${projectId}/checks`);
  ensureImplemented(res, 'GET /checks');
  const data = must(res, 200, 'checks');
  assert.ok(data.rejection && data.duplicate, '缺少 rejection/duplicate');
  return `废标 ${data.rejection.veto_count} / 查重 ${(Number(data.duplicate.max_similarity) * 100).toFixed(1)}%`;
});

/* ═════════════════════════════ 3. 工作流：mock 模型 + 人工门禁 ═════════════════════════════ */

let originalSettings = null;

await check('切换 llm.mode=mock（保证演示可复现）', async () => {
  originalSettings = must(await api('GET', '/api/settings'), 200, 'GET /settings');
  const res = await api('PUT', '/api/settings', { body: { llm: { ...originalSettings.llm, mode: 'mock' } } });
  must(res, 200, 'PUT /settings');
  const status = must(await api('GET', '/api/llm/status'), 200, '/llm/status');
  assert.equal(status.mode, 'mock', `llm.mode=${status.mode}`);
  return `mode=${status.mode}（原值 ${originalSettings.llm?.mode}，结束时恢复）`;
});

let runA = '';
let gateA = null;

await check('启动工作流并到达 waiting_human（≤120s）', async () => {
  const res = await api('POST', '/api/runs', { body: { projectId, objective: '冒烟：完整投标流程' } });
  ensureImplemented(res, 'POST /api/runs');
  const created = must(res, 201, 'POST /api/runs');
  runA = created.run_id;
  assert.ok(runA, '未返回 run_id');
  const snap = await waitRun(runA, ['waiting_human', 'failed'], WAIT_MS);
  assert.equal(snap.run.status, 'waiting_human', `run=${snap.run.status} ${snap.run.error_message || ''}`);
  gateA = snap.nodes.find((n) => n.status === 'waiting_human');
  assert.ok(gateA, '没有 waiting_human 节点');
  return `run ${runA.slice(0, 14)} / gate=${gateA.node_key} / 节点 ${snap.nodes.length}`;
});

let reviewA = null;

await check('审核包字段（产物 / 质量 / SLA / level_track / targets）', async () => {
  const rows = await waitFor('run A 出现待审任务', async () => {
    const list = await pendingReviews(runA);
    return list.length ? list : null;
  });
  reviewA = rows[0];
  const data = must(await api('GET', `/api/reviews/${reviewA.id}`), 200, 'GET /reviews/:id');
  assert.ok(String(data.subject?.artifact_kind || '').length > 0, '缺少 subject.artifact_kind');
  assert.ok(data.subject?.payload !== undefined, '缺少产物内容');
  assert.ok(data.quality && Number.isFinite(Number(data.quality.total)), `quality.total=${data.quality?.total}`);
  assert.ok(['pre_quality', 'post_quality'].includes(data.quality.stage), `quality.stage=${data.quality.stage}`);
  assert.ok(data.sla && Number.isFinite(Number(data.sla.minutes_left)), 'SLA 缺失');
  assert.ok(Array.isArray(data.level_track) && data.level_track.length >= 1, 'level_track 为空');
  assert.ok(Array.isArray(data.targets) && data.targets.length >= 1, 'targets 为空');
  assert.ok(String(data.purpose || '').length >= 10, '缺少闸门说明 purpose');
  assert.ok(Array.isArray(data.checklist) && data.checklist.length >= 2, '缺少核对清单 checklist');
  assert.equal(data.action_meaning?.length, 4, '动作含义缺失');
  assert.deepEqual(data.allowed_actions?.slice().sort(), ['approve', 'modify', 'reanalyze', 'reject']);
  return `gate=${data.gate_key} L${data.level}/${data.level_total} quality=${data.quality.total}/${data.quality.verdict} SLA=${data.sla.minutes_left}min targets=${data.targets.length}`;
});

await check('评论线程 POST / GET', async () => {
  const body = '已核对招标解析与技术策略，请补充等保三级整改台账的样例。';
  const created = must(await api('POST', `/api/reviews/${reviewA.id}/comments`, { body: { body } }), [200, 201], 'POST /comments');
  assert.ok(created.id, '评论未返回 id');
  const list = must(await api('GET', `/api/reviews/${reviewA.id}/comments`), 200, 'GET /comments');
  assert.ok(Array.isArray(list.comments) && list.comments.length >= 1, '评论线程为空');
  assert.ok(list.comments.some((c) => c.body === body), '未读到刚写入的评论');
  return `${list.comments.length} 条 / 最新 ${list.comments.at(-1).author_name}`;
});

await check('转派（admin）', async () => {
  const users = must(await api('GET', '/api/users'), 200, '/api/users');
  const owner = users.find((u) => u.username === 'owner');
  assert.ok(owner, '未找到 owner 账号');
  const data = must(await api('POST', `/api/reviews/${reviewA.id}/reassign`, { body: { assigneeId: owner.id, commandId: crypto.randomUUID() } }), 200, 'reassign');
  assert.equal(data.assignee_id, owner.id);
  assert.ok(String(data.assignee_name || '').length > 0);
  assert.ok(Number(data.comment_count) >= 1, '转派应写系统评论');
  return `→ ${data.assignee_name} / SLA 重置至 ${data.sla_due_at}`;
});

await check('驳回非祖先目标 → 409 REVIEW_TARGET_NOT_ANCESTOR', async () => {
  const res = await api('POST', `/api/reviews/${reviewA.id}/decisions`, {
    body: { action: 'reject', comment: '技术方案太空，需要重写并补齐响应矩阵。', targets: ['tech'], commandId: crypto.randomUUID() },
  });
  assert.equal(res.status, 409, `期望 409，实际 ${res.status} ${JSON.stringify(res.data)}`);
  assert.equal(res.data?.code, 'REVIEW_TARGET_NOT_ANCESTOR');
  return `code=${res.data.code}（tech 是下游，不应被接受）`;
});

const approveIdempotent = crypto.randomUUID();

await check('approve + 幂等（同 commandId 重放返回同一结果）', async () => {
  const payload = { action: 'approve', comment: '招标解析与投标策略结论认可，进入技术方案编制。', commandId: approveIdempotent };
  const first = must(await api('POST', `/api/reviews/${reviewA.id}/decisions`, { body: payload }), 200, 'approve');
  const second = must(await api('POST', `/api/reviews/${reviewA.id}/decisions`, { body: payload }), 200, 'approve replay');
  assert.deepEqual(second, first, '重放结果与首次不一致');
  assert.equal(first.success, true);
  assert.ok(['waiting_human', 'succeeded', 'rerouted'].includes(first.node_status), `node_status=${first.node_status}`);
  return `action=${first.action} node_status=${first.node_status} replay=一致`;
});

await check('乐观锁：同一任务重复决策 → 409 REVIEW_ALREADY_DECIDED', async () => {
  const res = await api('POST', `/api/reviews/${reviewA.id}/decisions`, {
    body: { action: 'approve', comment: '再次通过（应被乐观锁拒绝）', commandId: crypto.randomUUID() },
  });
  assert.equal(res.status, 409, `期望 409，实际 ${res.status} ${JSON.stringify(res.data)}`);
  assert.equal(res.data?.code, 'REVIEW_ALREADY_DECIDED');
  return `code=${res.data.code}`;
});

/* ═════════════════════════════ 4. run B：modify / reanalyze / skip-node ═════════════════════════════ */

let runB = '';
let gateB = null;

await check('run B：启动并到达人工门禁', async () => {
  const created = must(await api('POST', '/api/runs', { body: { projectId, objective: '冒烟：人工返工与跳过' } }), 201, 'POST /api/runs');
  runB = created.run_id;
  const snap = await waitRun(runB, ['waiting_human', 'failed'], WAIT_MS);
  assert.equal(snap.run.status, 'waiting_human', `run=${snap.run.status}`);
  gateB = snap.nodes.find((n) => n.status === 'waiting_human');
  assert.ok(gateB);
  return `run ${runB.slice(0, 14)} / gate=${gateB.node_key}`;
});

let reviewB = null;

await check('modify：带 edits 且目标重跑后门禁重开', async () => {
  const list = await waitFor('run B 待审任务', async () => {
    const rows = await pendingReviews(runB);
    return rows.length ? rows : null;
  });
  reviewB = list[0];
  const before = (await api('GET', `/api/runs/${runB}`)).data;
  const attemptBefore = before.nodes.find((n) => n.node_key === gateB.node_key)?.attempt ?? 0;
  const data = must(await api('POST', `/api/reviews/${reviewB.id}/decisions`, {
    body: {
      action: 'modify',
      comment: '目录缺少等保合规专项，请补充后重新生成技术方案。',
      targets: ['parse-tender'],
      edits: [{ op: 'append', path: 'outline.add_section', value: '等保 2.0 三级合规专项说明' }],
      commandId: crypto.randomUUID(),
    },
  }), 200, 'modify');
  assert.ok(Array.isArray(data.target_nodes) && data.target_nodes.includes('parse-tender'), `target_nodes=${JSON.stringify(data.target_nodes)}`);
  assert.equal(data.success, true);
  const reopened = await waitFor('门禁重开', async () => {
    const rows = await pendingReviews(runB);
    return rows.length ? rows : null;
  }, WAIT_MS, 700);
  reviewB = reopened[0];
  const after = (await api('GET', `/api/runs/${runB}`)).data;
  const target = after.nodes.find((n) => n.node_key === 'parse-tender');
  assert.ok(target && target.attempt >= 1, `parse-tender attempt=${target?.attempt}`);
  const gateAttempt = after.nodes.find((n) => n.node_key === gateB.node_key)?.attempt ?? 0;
  return `parse-tender attempt=${target.attempt} / gate 重开 L${reviewB.level} / gate.attempt ${attemptBefore}→${gateAttempt}`;
});

await check('reanalyze：旧产物 superseded 并重新分析', async () => {
  const data = must(await api('POST', `/api/reviews/${reviewB.id}/decisions`, {
    body: {
      action: 'reanalyze',
      comment: '招标解析口径有遗漏，请以原文重新分析后再走策略。',
      targets: ['parse-tender'],
      commandId: crypto.randomUUID(),
    },
  }), 200, 'reanalyze');
  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.superseded_artifacts), 'superseded_artifacts 应为数组');
  assert.ok(data.superseded_artifacts.length >= 1, `superseded=${data.superseded_artifacts.length}（应至少取代 1 个旧产物）`);
  const snapshot = (await api('GET', `/api/runs/${runB}`)).data;
  const superseded = snapshot.artifacts.filter((a) => a.status === 'superseded');
  assert.ok(superseded.length >= 1, '产物列表里没有 superseded 版本');
  return `${data.superseded_artifacts.length} 个产物被取代 / run=${data.run_status}`;
});

await check('skip-node：跳过可跳节点并取消其待办审核', async () => {
  const snap = (await api('GET', `/api/runs/${runB}`)).data;
  const skippable = new Set(['pending', 'ready', 'failed', 'waiting_human', 'invalidated']);
  const candidate = snap.nodes.find((n) => n.node_key === gateB.node_key && skippable.has(n.status))
    || snap.nodes.find((n) => skippable.has(n.status));
  if (!candidate) skip('run B 当前没有处于可跳状态的节点');
  const data = must(await api('POST', `/api/runs/${runB}/nodes/${encodeURIComponent(candidate.node_key)}/skip`, {
    body: { commandId: crypto.randomUUID() },
  }), 200, 'skip-node');
  assert.equal(data.node_status, 'skipped', `node_status=${data.node_status}`);
  assert.ok(data.previous_status, '缺少 previous_status');
  return `${candidate.node_key} ${data.previous_status}→skipped / run=${data.run_status}`;
});

await check('reconcile：中断恢复对账', async () => {
  const data = must(await api('POST', `/api/runs/${runA}/commands`, {
    body: { type: 'reconcile', commandId: crypto.randomUUID() },
  }), 200, 'reconcile');
  assert.equal(data.success, true);
  assert.ok(Array.isArray(data.interrupted), 'interrupted 应为数组');
  return `interrupted=${data.interrupted.length} recovered=${data.recovered?.length ?? 0}`;
});

/* ═════════════════════════════ 5. run A：多级审核到完成 ═════════════════════════════ */

await check('多级审核：level 1 通过后生成 level 2', async () => {
  const level1 = await waitFor('run A 出现 review-2 的待审任务', async () => {
    const list = await pendingReviews(runA);
    return list.find((r) => r.level_total > 1 && r.level === 1) || null;
  }, WAIT_MS, 800);
  const data = must(await api('POST', `/api/reviews/${level1.id}/decisions`, {
    body: { action: 'approve', comment: '第一级审核通过（项目负责人），转下一级复核。', commandId: crypto.randomUUID() },
  }), 200, 'approve L1');
  assert.ok(data.next_review, '未生成下一级审核任务');
  assert.equal(Number(data.next_review.level), 2, `next level=${data.next_review.level}`);
  const next = must(await api('GET', `/api/reviews/${data.next_review.id}`), 200, 'GET next review');
  assert.equal(Number(next.level), 2);
  assert.equal(next.status, 'pending');
  assert.ok(next.level_track.some((t) => Number(t.level) === 2), 'level_track 缺少第 2 级');
  return `gate=${level1.gate_key} L1→L2（下一任务 ${String(data.next_review.id).slice(0, 10)}）`;
});

await check('多次 approve 直至运行 completed', async () => {
  const started = Date.now();
  let approvals = 0;
  let lastStatus = '';
  while (Date.now() - started < WAIT_MS * 2) {
    const snap = (await api('GET', `/api/runs/${runA}`)).data;
    lastStatus = snap?.run?.status;
    if (lastStatus === 'completed') break;
    if (lastStatus === 'failed') throw new Error(`运行失败：${snap.run.error_message || snap.run.error_code}`);
    const pending = await pendingReviews(runA);
    if (!pending.length) { await sleep(800); continue; }
    for (const task of pending) {
      const res = await api('POST', `/api/reviews/${task.id}/decisions`, {
        body: { action: 'approve', comment: '内容与合规检查符合要求，同意定稿并导出正式投标文件。', commandId: crypto.randomUUID() },
      });
      if (res.status === 200) approvals += 1;
      else if (res.status !== 409) throw new Error(`approve 失败 ${res.status} ${JSON.stringify(res.data)?.slice(0, 200)}`);
    }
    await sleep(600);
  }
  assert.equal(lastStatus, 'completed', `最终状态 ${lastStatus}`);
  const snap = (await api('GET', `/api/runs/${runA}`)).data;
  assert.ok((snap.artifacts || []).some((a) => a.kind === 'doc.docx'), '缺少 doc.docx 产物');
  return `${approvals} 次决策 / 节点 ${snap.stats?.succeeded}/${snap.stats?.nodes} / 产物 ${snap.artifacts.length}`;
});

await check('投标文件按第七章格式组装（表单 + 待编制清单）', async () => {
  const rows = must(await api('GET', `/api/runs/${runA}/artifacts/doc.docx`), 200, 'doc.docx');
  const payload = rows?.[0]?.payload_json;
  const sections = payload?.sections || [];
  assert.ok(sections.length >= 12, `组装条目 ${sections.length} < 12`);
  const titles = sections.map((s) => s.title).join('、');
  for (const key of ['投标函', '开标一览表', '技术方案', '中小企业声明函']) {
    assert.ok(titles.includes(key), `投标文件缺少「${key}」章节`);
  }
  return `${sections.length} 项 / 待编制 ${payload?.gaps?.length ?? 0} 项`;
});

await check('十步流水线产物齐全（格式/四类审查/法规/一致性/汇总）', async () => {
  const artifacts = must(await api('GET', `/api/runs/${runA}/artifacts`), 200, 'artifacts');
  const kinds = new Set(artifacts.map((a) => a.kind));
  const required = [
    'tender.analysis', 'tender.format', 'knowledge.pack',
    'review.qualification', 'review.technical', 'review.material', 'review.other',
    'legal.pack', 'tech.content', 'commercial.pack', 'consistency.report', 'summary.pack', 'doc.docx',
  ];
  const missing = required.filter((kind) => !kinds.has(kind));
  assert.equal(missing.length, 0, `缺少产物：${missing.join('、')}`);
  return `${kinds.size} 类产物 / 必需 ${required.length} 类`;
});

await check('Agent 配置注入运行日志（提示词 / 档位 / 工具）', async () => {
  const events = must(await api('GET', `/api/runs/${runA}/events`), 200, 'events');
  const logs = events.filter((e) => e.type === 'node.log' && JSON.stringify(e.payload_json).includes('· 档位'));
  assert.ok(logs.length >= 5, `读到 Agent 配置的节点只有 ${logs.length} 个`);
  const sample = logs[0].payload_json.message;
  assert.ok(/提示词 \d+ 字/.test(sample), `日志格式异常：${sample}`);
  assert.ok(/工具 \d+ 个/.test(sample), `日志缺少工具数：${sample}`);
  return `${logs.length} 个节点读到 Agent 配置，示例：${sample.slice(0, 36)}`;
});

await check('Supervisor 视图（计划 / 决策 / 预算 / 并行批次）', async () => {
  const res = await api('GET', `/api/runs/${runA}/supervisor`);
  ensureImplemented(res, 'GET /api/runs/:id/supervisor');
  const data = must(res, 200, 'supervisor');
  assert.ok(data.plan?.node_count >= 8, `plan.node_count=${data.plan?.node_count}`);
  assert.ok(Array.isArray(data.decisions) && data.decisions.length >= 1, 'decisions 为空');
  assert.ok(Number(data.budget?.max_tokens) > 0, 'budget.max_tokens 缺失');
  assert.ok(Number(data.used?.tokens) > 0, `used.tokens=${data.used?.tokens}`);
  assert.ok(Array.isArray(data.parallel_batches), 'parallel_batches 应为数组');
  return `plan v${data.plan_version} / ${data.plan.node_count} 节点 / 决策 ${data.decisions.length} 条 / tokens ${data.used.tokens}`;
});

await check('SLA 提醒（remind 接口）', async () => {
  const rows = (await api('GET', '/api/reviews?status=pending')).data || [];
  const target = rows[0];
  if (!target) skip('当前没有 pending 审核任务可提醒');
  const res = await api('POST', `/api/reviews/${target.id}/remind`, { body: {} });
  ensureImplemented(res, 'POST /reviews/:id/remind');
  must(res, 200, 'remind');
  return `${target.gate_key} 已提醒`;
});

await check('SLA 到期升级', async () => {
  skip('无法通过公开接口把 sla_due_at/remind_at 提前：PUT /api/settings 只影响全局 review 开关，审核策略表仅 seed 写入；等待真实 SLA（240 分钟）不可接受，故不构造。策略 default 第 1/2 级 on_timeout=escalate 已在 review.mjs scanSla 实现，可人工改库验证。');
});

await check('Self-Loop 质量返工（quality.revise 事件）', async () => {
  const events = must(await api('GET', `/api/runs/${runA}/events`), 200, 'events');
  const revise = events.filter((e) => e.type === 'quality.revise');
  const quality = must(await api('GET', `/api/runs/${runA}/quality`), 200, 'quality');
  assert.ok(quality.length >= 1, '质量报告为空');
  if (!revise.length) skip(`本次运行质量一次通过（${quality.map((q) => `${q.node_key}#${q.iteration}:${q.total_score}/${q.verdict}`).join(' ')}），未触发返工`);
  return `返工 ${revise.length} 次 / 质量报告 ${quality.length} 份`;
});

/* ═════════════════════════════ 6. 质量配置与报告 ═════════════════════════════ */

await check('质量配置校验（Σ权重≠100 → 400 QUALITY_CONFIG_INVALID）', async () => {
  const res = await api('PUT', '/api/quality/config', {
    body: {
      weights: { requirement_coverage: 30, accuracy: 25, technical_quality: 20, material_match: 10, documentation: 5 },
      thresholds: { pass: 80, revise: 60 },
      judge: { enabled: true, cap_share: 0.155 },
      veto: { cap: 59 },
      max_iterations: 3,
    },
  });
  ensureImplemented(res, 'PUT /api/quality/config');
  assert.equal(res.status, 400, `期望 400，实际 ${res.status} ${JSON.stringify(res.data)}`);
  assert.equal(res.data?.code, 'QUALITY_CONFIG_INVALID');
  const config = must(await api('GET', '/api/quality/config'), 200, 'GET /quality/config');
  const sum = Object.values(config.weights).reduce((a, b) => a + Number(b), 0);
  assert.equal(sum, 100, `配置被写坏：权重合计 ${sum}`);
  return `code=${res.data.code} / 原配置仍为 Σ=${sum}`;
});

await check('质量报告列表 /quality/reports', async () => {
  const res = await api('GET', `/api/quality/reports?runId=${encodeURIComponent(runA)}`);
  ensureImplemented(res, 'GET /quality/reports');
  const data = must(res, 200, 'quality/reports');
  assert.ok(Array.isArray(data) && data.length >= 1, '报告为空');
  const report = data.at(-1);
  assert.ok(Number(report.total_score) > 0, `total_score=${report.total_score}`);
  assert.ok(report.dimension && Object.keys(report.dimension).length >= 1, '缺少维度明细');
  assert.ok(Array.isArray(report.findings), '缺少 findings');
  return `${data.length} 份 / 最新 ${report.node_key}#${report.iteration} ${report.total_score}/${report.verdict}`;
});

/* ═════════════════════════════ 7. 兼容层 ═════════════════════════════ */

await check('兼容层 /api/technical-plan', async () => {
  const res = await api('GET', `/api/technical-plan?projectId=${projectId}`);
  ensureImplemented(res, 'GET /api/technical-plan');
  const data = must(res, 200, '/api/technical-plan');
  assert.ok((data.analysisRaw?.requirements || []).length > 10, `analysisRaw.requirements=${data.analysisRaw?.requirements?.length}`);
  assert.ok((data.outlineData?.sections || []).length >= 8, `outlineData.sections=${data.outlineData?.sections?.length}`);
  assert.ok(Number(data.content?.total_words) > 800, `content.total_words=${data.content?.total_words}`);
  return `${data.analysisRaw.requirements.length} 条款 / ${data.outlineData.sections.length} 章 / ${data.content.total_words} 字`;
});

await check('兼容层 /api/tasks/start-bid-analysis', async () => {
  const other = projects.find((p) => p.id !== projectId);
  if (!other) skip('只有一个项目，无法隔离兼容层任务');
  const res = await api('POST', '/api/tasks/start-bid-analysis', {
    body: {},
    headers: { 'X-Project-Id': String(other.id) },
  });
  ensureImplemented(res, 'POST /api/tasks/start-bid-analysis');
  const data = must(res, 200, 'start-bid-analysis');
  assert.ok(data.task_id || data.id, '未返回 task id');
  await waitFor('兼容层任务结束', async () => {
    const active = must(await api('GET', '/api/tasks/active', { headers: { 'X-Project-Id': String(other.id) } }), 200, '/tasks/active');
    return active.length === 0;
  }, 60_000, 400);
  const state = must(await api('GET', `/api/technical-plan?projectId=${other.id}`), 200, '/api/technical-plan');
  assert.ok((state.analysisRaw?.requirements || []).length > 0, '兼容任务未写入解析结果');
  return `project #${other.id} 解析 ${state.analysisRaw.requirements.length} 条`;
});

await check('兼容层 /api/export/docx', async () => {
  const res = await api('POST', '/api/export/docx', { body: { projectId }, timeout: 120_000 });
  ensureImplemented(res, 'POST /api/export/docx');
  const data = must(res, 200, '/api/export/docx');
  assert.ok(String(data.file || '').startsWith('/files/'), `file=${data.file}`);
  assert.ok(Number(data.size) > 5000, `size=${data.size}`);
  const download = await api('GET', data.file, { auth: '' });
  assert.equal(download.status, 200);
  const buf = download.buf || Buffer.from(String(download.data));
  assert.equal(buf.slice(0, 2).toString(), 'PK', '不是 docx');
  return `${data.file} / ${data.size} bytes / ${data.words} 字`;
});

await check('兼容层 /api/events（读到 1 帧）', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${BASE}/api/events?projectId=${projectId}&token=${encodeURIComponent(token)}`, { signal: controller.signal });
    assert.equal(res.status, 200, `SSE 状态 ${res.status}`);
    assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'), 'Content-Type 不是 text/event-stream');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    // 并行触发一个项目域事件，避免干等
    const trigger = api('POST', `/api/projects/${projectId}/checks/rejection/run`, { body: {} }).catch(() => null);
    let frames = 0;
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const matches = buffer.split('\n\n').filter((block) => block.includes('event:') && block.includes('data:'));
      if (matches.length) {
        frames = matches.length;
        const first = matches[0];
        assert.ok(/event: (workflow|review|quality|tasks)/.test(first), `首帧频道异常：${first.slice(0, 120)}`);
        buffer = first;
        break;
      }
    }
    controller.abort();
    await trigger;
    assert.ok(frames >= 1, '7 秒内未读到 SSE 数据帧');
    return `首帧：${buffer.split('\n').slice(0, 2).join(' ').slice(0, 120)}`;
  } finally {
    clearTimeout(timer);
    try { controller.abort(); } catch { /* ignore */ }
  }
});

/* ═════════════════════════════ 8. 权限 ═════════════════════════════ */

await check('权限：普通用户访问他人项目 → 403', async () => {
  const techToken = tokens.tech;
  const res = await api('GET', `/api/projects/${projectId}`, { auth: techToken });
  ensureImplemented(res, 'GET /api/projects/:id');
  assert.equal(res.status, 403, `期望 403，实际 ${res.status} ${JSON.stringify(res.data)}`);
  assert.ok(['FORBIDDEN'].includes(res.data?.code) || /无权/.test(String(res.data?.error)));
  const workspace = await api('GET', `/api/projects/${projectId}/workspace`, { auth: techToken });
  assert.equal(workspace.status, 403, `workspace 期望 403，实际 ${workspace.status}`);
  return `tech 访问 #${projectId} → 403（详情 + workspace）`;
});

await check('权限：非 admin 改 users → 403', async () => {
  const res = await api('POST', '/api/users', {
    auth: tokens.owner,
    body: { username: `smoke_${Date.now()}`, password: 'smoke123456', role: 'user' },
  });
  ensureImplemented(res, 'POST /api/users');
  assert.equal(res.status, 403, `期望 403，实际 ${res.status} ${JSON.stringify(res.data)}`);
  assert.equal(res.data?.code, 'ADMIN_ONLY');
  const patch = await api('PATCH', '/api/users/2', { auth: tokens.owner, body: { title: '越权改职称' } });
  assert.equal(patch.status, 403, `PATCH 期望 403，实际 ${patch.status}`);
  return `POST/PATCH /api/users → 403 ADMIN_ONLY`;
});

/* ═════════════════════════════ 9. 知识库资料上传（Word / 图片 / 附件） ═════════════════════════════ */

const createdDocs = [];
let docxDoc = null;
let imageDoc = null;
let txtFileId = '';

await check('上传 DOCX → 201 + 正文关键词 + meta.files', async () => {
  const form = fileForm('冒烟方案.docx', makeDocx(), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  form.append('library', UPLOAD_LIBRARY);
  form.append('category', 'template');
  form.append('folder', '冒烟上传');
  form.append('tags', '冒烟,docx');
  const res = await upload('/api/knowledge/upload', form);
  assert.equal(res.status, 201, `期望 201，实际 ${res.status} ${JSON.stringify(res.data)?.slice(0, 300)}`);
  assert.ok(Array.isArray(res.data?.documents) && res.data.documents.length === 1, `documents=${res.data?.documents?.length}`);
  docxDoc = res.data.documents[0];
  createdDocs.push(docxDoc.id);
  assert.equal(docxDoc.library, 'doc');
  assert.ok(Array.isArray(docxDoc.files) && docxDoc.files.length === 1, `files=${docxDoc.files?.length}`);
  const entry = docxDoc.files[0];
  assert.equal(entry.ext, '.docx');
  assert.ok(entry.sha256 && Number(entry.bytes) > 500, '附件元数据缺 sha256/bytes');
  assert.ok(String(entry.stored).startsWith(`${entry.id}-`), `stored 命名异常：${entry.stored}`);
  assert.ok(String(docxDoc.content).includes(DOCX_KEYWORD), `正文未包含关键词：${String(docxDoc.content).slice(0, 120)}`);
  assert.ok(String(docxDoc.content).includes('# 智慧园区运维方案'), '标题层级未还原');
  assert.ok(String(docxDoc.content).includes('交付项 | 周期'), '表格未还原');
  assert.equal(docxDoc.parse?.status, 'ok', `parse.status=${docxDoc.parse?.status}`);
  assert.equal(docxDoc.parse?.kind, 'docx');
  assert.ok(Number(docxDoc.parse?.chars) >= DOCX_KEYWORD.length, `chars=${docxDoc.parse?.chars}`);
  return `${docxDoc.id} / ${docxDoc.parse.chars} 字 / files=${docxDoc.files.length}`;
});

await check('上传图片 → 201 + 原件下载字节一致 + inline/attachment', async () => {
  const form = fileForm('证书.png', PNG_1PX, 'image/png');
  form.append('library', 'company');
  const res = await upload('/api/knowledge/upload', form);
  assert.equal(res.status, 201, `期望 201，实际 ${res.status} ${JSON.stringify(res.data)?.slice(0, 300)}`);
  imageDoc = res.data.documents[0];
  createdDocs.push(imageDoc.id);
  assert.equal(imageDoc.parse?.status, 'image', `parse.status=${imageDoc.parse?.status}`);
  assert.ok(String(imageDoc.content).includes('未做 OCR'), `图片提示缺失：${imageDoc.content}`);
  const url = `/api/knowledge/${imageDoc.id}/files/${imageDoc.files[0].id}?token=${encodeURIComponent(token)}`;
  const dl = await api('GET', url, { auth: '' });
  assert.equal(dl.status, 200, `下载状态 ${dl.status}`);
  assert.equal(dl.headers.get('content-type'), 'image/png');
  assert.equal(dl.buf?.length, PNG_1PX.length, `下载字节 ${dl.buf?.length}`);
  assert.equal(Buffer.compare(dl.buf, PNG_1PX), 0, '下载字节与上传不一致');
  assert.ok(String(dl.headers.get('content-disposition') || '').startsWith('inline'), '默认应为 inline');
  const att = await api('GET', `${url}&download=1`, { auth: '' });
  assert.equal(att.status, 200);
  assert.ok(String(att.headers.get('content-disposition') || '').startsWith('attachment'), '?download=1 应为 attachment');
  return `${PNG_1PX.length} bytes / image/png / inline+attachment`;
});

await check('追加附件 → 200 + 重解析合并正文', async () => {
  if (!imageDoc) skip('图片上传未成功，跳过追加');
  const text = '补充说明：证书有效期至 2027-12-31。';
  const res = await upload(`/api/knowledge/${imageDoc.id}/files`, fileForm('补充说明.txt', Buffer.from(text, 'utf8'), 'text/plain'));
  assert.equal(res.status, 200, `期望 200，实际 ${res.status} ${JSON.stringify(res.data)?.slice(0, 300)}`);
  assert.equal(res.data.added?.length, 1, `added=${res.data.added?.length}`);
  assert.equal(res.data.document?.files?.length, 2, `files=${res.data.document?.files?.length}`);
  assert.ok(String(res.data.document.content).includes('证书有效期至 2027-12-31'), '正文未合并新附件');
  txtFileId = res.data.document.files.find((f) => f.ext === '.txt')?.id || res.data.added[0].id;
  return `files=${res.data.document.files.length} / chars=${res.data.document.parse?.chars}`;
});

await check('删除附件 → 200 + 磁盘文件消失 + 再取 404', async () => {
  if (!imageDoc || !txtFileId) skip('追加附件未成功，跳过删除');
  const before = must(await api('GET', `/api/knowledge/${imageDoc.id}`), 200, 'GET /api/knowledge/:id');
  const target = before.files.find((f) => f.id === txtFileId);
  assert.ok(target, '找不到刚追加的附件');
  const diskPath = path.join(FILES_ROOT, imageDoc.id, target.stored);
  assert.equal(fs.existsSync(diskPath), true, `上传后磁盘没有原件：${diskPath}`);
  const res = await api('DELETE', `/api/knowledge/${imageDoc.id}/files/${encodeURIComponent(txtFileId)}`);
  must(res, 200, 'DELETE /:id/files/:fileId');
  assert.equal(res.data.removed, txtFileId);
  assert.equal(res.data.document?.files?.length, 1, `files=${res.data.document?.files?.length}`);
  assert.equal(fs.existsSync(diskPath), false, '磁盘原件未删除');
  const again = await api('GET', `/api/knowledge/${imageDoc.id}/files/${encodeURIComponent(txtFileId)}?token=${encodeURIComponent(token)}`, { auth: '' });
  assert.equal(again.status, 404, `删除后取件 ${again.status}`);
  assert.equal(again.data?.code, 'FILE_NOT_FOUND');
  return `${target.name} 已从素材与磁盘移除`;
});

await check('未登录上传 → 401 UNAUTHORIZED', async () => {
  const res = await upload('/api/knowledge/upload', fileForm('匿名.txt', Buffer.from('匿名上传'), 'text/plain'), { auth: '' });
  assert.equal(res.status, 401, `期望 401，实际 ${res.status} ${JSON.stringify(res.data)?.slice(0, 200)}`);
  assert.equal(res.data?.code, 'UNAUTHORIZED');
  return 'HTTP 401';
});

await check('扩展名与魔数不符 → 415 FILE_TYPE_UNSUPPORTED', async () => {
  const res = await upload('/api/knowledge/upload', fileForm('伪造证书.pdf', PNG_1PX, 'application/pdf'));
  assert.equal(res.status, 415, `期望 415，实际 ${res.status} ${JSON.stringify(res.data)?.slice(0, 200)}`);
  assert.equal(res.data?.code, 'FILE_TYPE_UNSUPPORTED');
  return `code=${res.data.code}（PNG 伪装成 .pdf 被拒）`;
});

await check('单文件超过 25MB → 413 FILE_TOO_LARGE', async () => {
  const big = Buffer.alloc(25 * 1024 * 1024 + 1024, 0x41);
  const res = await upload('/api/knowledge/upload', fileForm('超限.txt', big, 'text/plain'));
  assert.equal(res.status, 413, `期望 413，实际 ${res.status} ${JSON.stringify(res.data)?.slice(0, 200)}`);
  assert.equal(res.data?.code, 'FILE_TOO_LARGE');
  return `${big.length} bytes 被拒`;
});

await check('重解析 → content 按磁盘附件重建（覆盖手工改动）', async () => {
  if (!docxDoc) skip('DOCX 上传未成功，跳过重解析');
  const broken = '冒烟：人为改坏的正文，应该被重解析覆盖。';
  must(await api('PUT', `/api/knowledge/${docxDoc.id}`, { body: { title: docxDoc.title, content: broken } }), 200, 'PUT /api/knowledge/:id');
  const changed = must(await api('GET', `/api/knowledge/${docxDoc.id}`), 200, 'GET /api/knowledge/:id');
  assert.equal(changed.content, broken, 'PUT 未写入手工正文');
  const data = must(await api('POST', `/api/knowledge/${docxDoc.id}/reparse`, { body: {} }), 200, 'reparse');
  assert.ok(String(data.document.content).includes(DOCX_KEYWORD), '重解析后正文未恢复');
  assert.notEqual(data.document.content, broken);
  assert.equal(data.document.parse?.status, 'ok');
  return `${data.document.parse?.chars} 字已重建`;
});

await check('清理上传冒烟素材（DB + 磁盘附件）', async () => {
  for (const docId of createdDocs) {
    const dir = path.join(FILES_ROOT, docId);
    await api('DELETE', `/api/knowledge/${docId}`).catch(() => null);
    assert.equal(fs.existsSync(dir), false, `附件目录残留：${dir}`);
    const gone = await api('GET', `/api/knowledge/${docId}`);
    assert.equal(gone.status, 404, `素材未删除：${docId}`);
  }
  return `${createdDocs.length} 个素材及其附件目录已清理`;
});

/* ═════════════════════════════ 10. 项目删除（级联清理） ═════════════════════════════ */

let doomedProjectId = 0;

await check('创建待删除项目', async () => {
  const data = must(await api('POST', '/api/projects', {
    body: {
      name: `冒烟删除项目 ${Date.now()}`,
      code: `SMOKE-DEL-${Date.now()}`,
      tenderText: '冒烟：用于验证项目删除与级联清理的招标正文。'.repeat(20),
    },
  }), 201, 'POST /api/projects');
  doomedProjectId = data.id;
  assert.ok(doomedProjectId, '未返回项目 id');
  return `#${doomedProjectId} ${data.code}`;
});

await check('删除预览 → 关联计数（空项目）', async () => {
  const data = must(await api('GET', `/api/projects/${doomedProjectId}/deletion-preview`), 200, 'deletion-preview');
  assert.equal(Number(data.counts.runs), 0, `runs=${data.counts.runs}`);
  return `runs=0 / exports=0 / has_state=${data.counts.has_state}`;
});

await check('启动一次运行制造级联数据', async () => {
  const created = must(await api('POST', '/api/runs', {
    body: { projectId: doomedProjectId, objective: '冒烟：删除前制造运行与审核数据' },
  }), 201, 'POST /api/runs');
  const snap = await waitRun(created.run_id, ['waiting_human', 'failed'], 90_000);
  assert.notEqual(snap.run.status, 'failed', `运行失败：${snap.run.error_message || snap.run.error_code}`);
  const preview = must(await api('GET', `/api/projects/${doomedProjectId}/deletion-preview`), 200, 'deletion-preview');
  assert.ok(Number(preview.counts.runs) >= 1, `预览 runs=${preview.counts.runs}`);
  assert.ok(Number(preview.counts.nodes) >= 1, `预览 nodes=${preview.counts.nodes}`);
  assert.ok(Number(preview.counts.reviews) >= 1, `预览 reviews=${preview.counts.reviews}`);
  return `run=${created.run_id.slice(0, 14)} / 节点 ${preview.counts.nodes} / 事件 ${preview.counts.events} / 审核 ${preview.counts.reviews}`;
});

await check('非负责人删除他人项目 → 403', async () => {
  const res = await api('DELETE', `/api/projects/${doomedProjectId}`, { auth: tokens.tech });
  assert.equal(res.status, 403, `期望 403，实际 ${res.status} ${JSON.stringify(res.data)?.slice(0, 200)}`);
  return 'tech → 403 FORBIDDEN';
});

await check('admin 删除项目 → 200 且级联计数非零', async () => {
  const data = must(await api('DELETE', `/api/projects/${doomedProjectId}`), 200, 'DELETE /api/projects/:id');
  assert.equal(data.success, true);
  assert.ok(Number(data.removed.runs) >= 1, `removed.runs=${data.removed.runs}`);
  assert.ok(Number(data.removed.reviews) >= 1, `removed.reviews=${data.removed.reviews}`);
  const gone = await api('GET', `/api/projects/${doomedProjectId}`);
  assert.equal(gone.status, 404, `删除后仍可读取：${gone.status}`);
  const again = await api('DELETE', `/api/projects/${doomedProjectId}`);
  assert.equal(again.status, 404, `重复删除期望 404，实际 ${again.status}`);
  return `清理 运行 ${data.removed.runs} / 节点 ${data.removed.nodes} / 产物 ${data.removed.artifacts} / 审核 ${data.removed.reviews} / 质量 ${data.removed.quality}`;
});

/* ═════════════════════════════ 11. 项目级招标文件上传 ═════════════════════════════ */

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
let uploadProjectId = 0;

await check('创建上传验收项目', async () => {
  const data = must(await api('POST', '/api/projects', {
    body: { name: `冒烟上传项目 ${Date.now()}`, code: `SMOKE-UP-${Date.now()}` },
  }), 201, 'POST /api/projects');
  uploadProjectId = data.id;
  return `#${uploadProjectId}`;
});

await check('上传招标 docx → 正文落库', async () => {
  const form = new FormData();
  form.append('file', new Blob([makeTenderDocx()], { type: DOCX_MIME }), '招标文件-冒烟.docx');
  form.append('autoParse', '0');
  const res = await upload(`/api/projects/${uploadProjectId}/tender/upload`, form);
  must(res, 200, 'tender upload');
  assert.ok(Number(res.data.chars) > 200, `chars=${res.data.chars}`);
  const tender = must(await api('GET', `/api/projects/${uploadProjectId}/tender`), 200, 'tender');
  assert.ok(String(tender.text).includes('ISO9001'), '正文未落库');
  assert.equal(tender.name, '招标文件-冒烟.docx');
  return `${res.data.chars} 字 / ${res.data.note}`;
});

await check('上传后解析出要求条目', async () => {
  const data = await planStep(uploadProjectId, 'parse');
  const requirements = data.state?.bid_analysis?.requirements || [];
  assert.ok(requirements.length >= 5, `requirements=${requirements.length}`);
  return `${requirements.length} 条要求 / ${data.state?.bid_analysis?.project_meta?.code || '无编号'}`;
});

await check('不支持的后缀 → 415', async () => {
  const form = new FormData();
  // .doc/.wps 现在会尝试用本机 Word/WPS 转换，这里用确实不支持的压缩包验证 415
  form.append('file', new Blob([Buffer.from('PK\u0003\u0004 unsupported')], { type: 'application/zip' }), 'old.zip');
  const res = await upload(`/api/projects/${uploadProjectId}/tender/upload`, form);
  assert.equal(res.status, 415, `期望 415，实际 ${res.status}`);
  return `code=${res.data?.code}`;
});

await check('新建项目前预解析招标文件（/api/tender/parse）', async () => {
  const form = new FormData();
  form.append('file', new Blob([makeTenderDocx()], { type: DOCX_MIME }), '招标文件-预解析.docx');
  const res = await upload('/api/tender/parse', form);
  must(res, 200, 'tender/parse');
  assert.ok(Number(res.data.chars) >= 200, `chars=${res.data.chars}`);
  assert.ok(String(res.data.text).includes('ISO9001'), '正文未返回');
  return `${res.data.chars} 字 / 采购人 ${res.data.meta?.owner || '未识别'}`;
});

await check('粘贴招标正文 → 落库并解析', async () => {
  const text = Array.from({ length: 12 }, (_, i) => `3.${i + 1} 投标人须提供 7×24 小时运维服务，故障响应不超过 30 分钟。`).join('\n');
  const res = await api('POST', `/api/projects/${uploadProjectId}/tender/text`, { body: { text, autoParse: 0 } });
  must(res, 200, 'tender/text');
  assert.ok(Number(res.data.chars) >= 200, `chars=${res.data.chars}`);
  const tender = must(await api('GET', `/api/projects/${uploadProjectId}/tender`), 200, 'tender');
  assert.ok(String(tender.text).includes('7×24 小时运维服务'), '正文未落库');
  const data = await planStep(uploadProjectId, 'parse');
  const requirements = data.state?.bid_analysis?.requirements || [];
  assert.ok(requirements.length >= 5, `requirements=${requirements.length}`);
  return `${res.data.chars} 字 → ${requirements.length} 条要求`;
});

await check('无文本层 PDF → 422 PDF_NO_TEXT（提示走 OCR/粘贴）', async () => {
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
    + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
    + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R>>endobj\n'
    + '4 0 obj<</Length 0>>\nstream\n\nendstream\nendobj\n'
    + 'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
  const form = new FormData();
  form.append('file', new Blob([pdf], { type: 'application/pdf' }), '扫描件-招标文件.pdf');
  form.append('autoParse', '0');
  const res = await upload(`/api/projects/${uploadProjectId}/tender/upload`, form);
  assert.equal(res.status, 422, `期望 422，实际 ${res.status}`);
  assert.equal(res.data?.code, 'PDF_NO_TEXT');
  return `${res.data.code}：${String(res.data.error).slice(0, 30)}…`;
});

await check('清理上传验收项目', async () => {
  const data = must(await api('DELETE', `/api/projects/${uploadProjectId}`), 200, 'DELETE project');
  const gone = await api('GET', `/api/projects/${uploadProjectId}`);
  assert.equal(gone.status, 404, '项目未删除');
  return `清理运行 ${data.removed?.runs ?? 0} 条`;
});

/* ═════════════════════════════ 收尾：恢复设置 / 取消 run B ═════════════════════════════ */

await check('恢复 llm 配置并清理 run B', async () => {
  if (originalSettings?.llm) {
    const res = await api('PUT', '/api/settings', { body: { llm: originalSettings.llm } });
    must(res, 200, 'restore settings');
  }
  if (runB) {
    await api('POST', `/api/runs/${runB}/commands`, { body: { type: 'cancel', commandId: crypto.randomUUID() } }).catch(() => null);
  }
  const status = must(await api('GET', '/api/llm/status'), 200, '/llm/status');
  return `llm.mode=${status.mode}（已恢复）/ run B 已取消`;
});

/* ═════════════════════════════ 汇总 ═════════════════════════════ */

const total = stats.pass + stats.fail + stats.skip;
console.log('\n' + '─'.repeat(64));
console.log(`结果：${stats.pass}/${total} 通过，${stats.fail} 失败，${stats.skip} 跳过`);
if (skipNotes.length) {
  console.log('\n跳过项（接口未就绪或条件无法用公开接口构造）：');
  for (const note of skipNotes) console.log(` - ${note.title}: ${note.reason}`);
}
if (failures.length) {
  console.log('\n失败项：');
  for (const failure of failures) console.log(` - ${failure.title}\n   ${failure.message}`);
}
if (runA) console.log(`\n演示运行：${runA}`);
console.log('');
process.exit(failures.length ? 1 : 0);
