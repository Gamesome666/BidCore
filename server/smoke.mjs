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
  const history = must(await api('GET', `/api/projects/${projectId}/exports`), 200, '/exports');
  assert.ok(Array.isArray(history) && history.length >= 1, '导出历史为空');
  return `${data.bytes} bytes / sha=${String(data.sha256).slice(0, 12)} / 历史 ${history.length} 条`;
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
  assert.ok(data.quality && Number(data.quality.total) > 0, `quality.total=${data.quality?.total}`);
  assert.ok(data.sla && Number.isFinite(Number(data.sla.minutes_left)), 'SLA 缺失');
  assert.ok(Array.isArray(data.level_track) && data.level_track.length >= 1, 'level_track 为空');
  assert.ok(Array.isArray(data.targets) && data.targets.length >= 1, 'targets 为空');
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
