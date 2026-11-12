// 项目工作台数据适配层
// 契约：优先走新接口（workspace / technical-plan / deviation / checks / exports），
// 这些路由尚未实现时降级到兼容层（GET /api/technical-plan、POST /api/tasks/start-*、POST /api/export/docx），
// 兼容层也没有的动作（全局事实推导、偏离表确认、章节保存）落本地草稿，界面统一标注「本地」。
import { api, ApiError } from '../../lib/api.js';
import { wordCount } from '../../lib/ui.js';

const MISSING_STATUS = new Set([404, 405, 501]);

/** 接口未实现（stub 路由）判定 */
export function isMissing(error) {
  return error instanceof ApiError && MISSING_STATUS.has(error.status);
}

export const STEP_META = {
  parse: { label: '招标解析', compat: 'bid-analysis', desc: '抽取资格/技术/商务要求、评分办法与废标条款' },
  outline: { label: '目录生成', compat: 'outline-generation', desc: '按评分办法与技术条款映射章节' },
  facts: { label: '全局事实', compat: null, desc: '项目元信息与关键指标，供正文引用' },
  content: { label: '正文生成', compat: 'content-generation', desc: '逐章生成并附带来源引用' },
  checks: { label: '合规检查', compat: 'rejection-check', desc: '逐条核对废标条款与响应偏离' },
  rejection: { label: '废标检查', compat: 'rejection-check', desc: '核对废标条款响应' },
  duplicate: { label: '查重分析', compat: 'duplicate-analysis', desc: '章节两两比对相似度' },
  export: { label: '导出 Word', compat: null, desc: '生成 .docx 并提供下载' },
};

export const STEP_ORDER = ['parse', 'outline', 'facts', 'content', 'checks', 'export'];

/* ------------------------------------------------------------------ 分类 */
const CAT_KEY = { qualification: 'qualification', technical: 'technical', commercial: 'commercial', scoring: 'scoring', veto: 'veto', overview: 'overview', other: 'other' };
const CAT_ALIAS = { 资格: 'qualification', 资质: 'qualification', 技术: 'technical', 商务: 'commercial', 评分: 'scoring', 评审: 'scoring', 废标: 'veto', 无效: 'veto', 概述: 'overview', 其他: 'other' };
const CAT_LABEL = { qualification: '资格', technical: '技术', commercial: '商务', scoring: '评分', veto: '废标', overview: '概述', other: '其他' };
export const CAT_KIND = { qualification: 'info', technical: 'ok', commercial: 'warn', scoring: 'violet', veto: 'bad', overview: 'plain', other: 'plain' };

export function categoryKey(raw) {
  const value = String(raw || '').trim();
  if (!value) return 'other';
  if (CAT_KEY[value]) return value;
  if (CAT_ALIAS[value]) return CAT_ALIAS[value];
  if (/资格|资质/.test(value)) return 'qualification';
  if (/技术/.test(value)) return 'technical';
  if (/商务|报价/.test(value)) return 'commercial';
  if (/评分|评审/.test(value)) return 'scoring';
  if (/废标|无效/.test(value)) return 'veto';
  if (/概述|简介/.test(value)) return 'overview';
  return 'other';
}
export const categoryLabel = (key) => CAT_LABEL[key] || key || '其他';

/* ------------------------------------------------------------- 本地草稿 */
const draftKey = (pid) => `bidcore.ws-draft.${pid}`;

export function readDraft(pid) {
  try { return JSON.parse(localStorage.getItem(draftKey(pid)) || '{}') || {}; } catch { return {}; }
}

export function writeDraft(pid, patch) {
  const next = { ...readDraft(pid), ...patch, updated_at: new Date().toISOString() };
  try { localStorage.setItem(draftKey(pid), JSON.stringify(next)); } catch { /* 配额/隐私模式忽略 */ }
  return next;
}

/* --------------------------------------------------------------- 归一化 */
const asArray = (value) => (Array.isArray(value) ? value : []);

function normRequirement(row, index) {
  const category = categoryKey(row.category_key || row.category);
  const text = String(row.text || row.requirement || row.content || '');
  return {
    id: String(row.id || row.requirement_id || `REQ-${String(index + 1).padStart(2, '0')}`),
    order: row.order ?? index + 1,
    category,
    categoryLabel: categoryLabel(category),
    text,
    veto: Boolean(row.veto) || Boolean(row.veto_clause) || category === 'veto',
    must: Boolean(row.must) || Boolean(row.veto) || category === 'qualification',
    weight: row.weight ?? row.score ?? null,
    response: String(row.response || ''),
    responded: Boolean(row.responded) || Boolean(row.response),
    deviationResponse: '',
    sourceRef: String(row.source_ref || row.sourceRef || row.clause || ''),
    anchorHeading: String(row.source_anchor?.heading || row.sourceAnchor?.heading || ''),
    clause: String(row.clause || row.source_ref || ''),
    metrics: asArray(row.metrics),
    keywords: asArray(row.keywords),
  };
}

function flattenOutline(list, out = [], parentId = null, depth = 1, seen = new Set()) {
  for (const item of asArray(list)) {
    // 后端 children 是 ID 字符串数组（层级由 parent_id 表达）；只对对象子节点递归，
    // 否则会把 "n2" 这类 ID 当成节点，产生空标题重复行。
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id ?? item.node_id ?? item.key ?? `n${out.length + 1}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const parent = item.parentId ?? item.parent_id ?? parentId;
    const node = {
      id,
      no: String(item.no ?? item.number ?? ''),
      title: String(item.title || item.name || ''),
      level: Number(item.level || depth),
      parentId: parent == null ? null : String(parent),
      targetWords: Number(item.target_words ?? item.targetWords ?? 0),
      wordCount: Number(item.word_count ?? item.wordCount ?? 0),
      serverStatus: String(item.status || ''),
      children: [],
    };
    out.push(node);
    const objectChildren = asArray(item.children).filter((child) => child && typeof child === 'object');
    if (objectChildren.length) flattenOutline(objectChildren, out, id, node.level + 1, seen);
  }
  return out;
}

function buildOutlineTree(list) {
  const flat = flattenOutline(list);
  const byId = new Map(flat.map((node) => [node.id, node]));
  const roots = [];
  for (const node of flat) {
    const parent = node.parentId ? byId.get(node.parentId) : null;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return { flat, roots };
}

function collectChapters(raw = {}) {
  const chapters = {};
  const specChapters = raw.chapters && typeof raw.chapters === 'object' ? raw.chapters : {};
  for (const [id, value] of Object.entries(specChapters)) {
    if (!value || typeof value !== 'object') continue;
    const content = String(value.content ?? value.markdown ?? '');
    chapters[id] = {
      content,
      words: Number(value.word_count ?? value.words ?? wordCount(content)),
      status: value.status || (content ? 'done' : 'idle'),
      updatedAt: value.updated_at || value.updatedAt || null,
    };
  }
  // sections 只作为元信息（字数/引用）；正文以 markdown_by_node 为准，避免编辑时把派生文本回写
  for (const section of asArray(raw.sections)) {
    const id = String(section.id ?? section.node_id ?? section.nodeId ?? '');
    if (!id) continue;
    const existing = chapters[id] || {};
    chapters[id] = {
      content: existing.content || '',
      words: Number(section.words ?? section.word_count ?? existing.words ?? 0),
      status: existing.status || (existing.content ? 'done' : 'idle'),
      updatedAt: existing.updatedAt || raw.generated_at || null,
      refs: section.refs || existing.refs || null,
    };
  }
  const markdownByNode = raw.markdown_by_node && typeof raw.markdown_by_node === 'object' ? raw.markdown_by_node : {};
  for (const [id, value] of Object.entries(markdownByNode)) {
    const content = String(value || '');
    const existing = chapters[id] || {};
    chapters[id] = {
      ...existing,
      content,
      words: Number(wordCount(content) || existing.words || 0),
      status: existing.status === 'running' ? 'running' : content ? 'done' : existing.status || 'idle',
      updatedAt: existing.updatedAt || raw.generated_at || null,
    };
  }
  return chapters;
}

function deriveFacts(analysisProject, stats) {
  const facts = [];
  const push = (key, value, source) => { if (value !== undefined && value !== null && String(value).trim()) facts.push({ key, value: String(value), source }); };
  push('项目名称', analysisProject.name, '招标文件 · 项目元信息');
  push('采购编号', analysisProject.code, '招标文件 · 项目元信息');
  push('预算/最高限价', analysisProject.budget, '招标文件 · 项目元信息');
  push('服务期限', analysisProject.duration, '招标文件 · 项目元信息');
  push('项目地点', analysisProject.location, '招标文件 · 项目元信息');
  push('采购人', analysisProject.owner, '招标文件 · 项目元信息');
  if (stats) {
    push('招标要求条数', stats.requirement_count, '招标解析 · 统计');
    push('资格条款', stats.qualification, '招标解析 · 统计');
    push('技术条款', stats.technical, '招标解析 · 统计');
    push('商务条款', stats.commercial, '招标解析 · 统计');
    push('评分项', stats.scoring, '招标解析 · 统计');
    push('废标条款', stats.veto, '招标解析 · 统计');
  }
  return facts;
}

function normalizeDeviationRows(plan, source) {
  const rows = [];
  const seen = new Set();
  const listed = asArray(source?.rows);
  for (const [index, row] of listed.entries()) {
    const id = String(row.id || row.row_id || row.requirement_id || `d${index + 1}`);
    const response = String(row.response || '');
    rows.push({
      id,
      requirementId: String(row.requirement_id || ''),
      clause: String(row.clause || row.requirement_id || ''),
      requirement: String(row.requirement || row.text || ''),
      response,
      deviation: String(row.deviation || row.deviation_type || (response === '满足' ? '无偏离' : '')),
      evidence: String(row.evidence || row.note || ''),
      veto: Boolean(row.veto),
      manualEdited: Boolean(row.manual_edited),
    });
    seen.add(id);
    if (row.requirement_id) seen.add(String(row.requirement_id));
  }

  // 兼容层：从 rejectionCheck.deviations + 技术/商务条款推导
  const compat = asArray(plan.raw?.rejectionCheck?.deviations || plan.raw?.checks?.rejection?.deviations);
  for (const item of compat) {
    const id = String(item.requirement_id || item.id || `d${rows.length + 1}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const response = String(item.response || '');
    rows.push({
      id,
      requirementId: String(item.requirement_id || ''),
      clause: String(item.clause || item.requirement_id || ''),
      requirement: String(item.requirement || item.text || ''),
      response,
      deviation: String(item.deviation || (response === '满足' ? '无偏离' : response ? '待确认' : '')),
      evidence: String(item.evidence || item.note || ''),
    });
  }
  for (const req of plan.requirements) {
    if (!['technical', 'commercial'].includes(req.category)) continue;
    if (seen.has(req.id)) continue;
    seen.add(req.id);
    rows.push({ id: req.id, requirementId: req.id, clause: req.sourceRef || req.id, requirement: req.text, response: '', deviation: '', evidence: '' });
  }
  return rows;
}

/**
 * 技术方案状态归一化：同时兼容 BUILD-SPEC §4 的 project_state 形状
 * （bid_analysis/outline/global_facts/content/checks/deviation/export）
 * 与兼容层 technical-plan 形状（analysisRaw/outlineData/content/rejectionCheck/duplicateCheck）。
 */
export function normalizePlan(raw = {}, pid = 0) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const analysisRaw = src.analysisRaw || {};
  const analysisProject = src.bid_analysis?.project || analysisRaw.project || {};
  const stats = src.bid_analysis?.stats || analysisRaw.stats || null;

  const specReqs = asArray(src.bid_analysis?.requirements || src.requirements);
  const compatReqs = asArray(analysisRaw.requirements);
  const requirements = (specReqs.length ? specReqs : compatReqs).map(normRequirement);

  const specOutline = src.outline?.nodes || src.outline?.outline || src.outlineData?.outline || null;
  const compatOutline = src.outlineData?.sections || null;
  const { flat, roots } = buildOutlineTree(specOutline?.length ? specOutline : compatOutline || []);

  const chapters = collectChapters(src.content || {});
  const draft = readDraft(pid);
  const draftChapters = draft.chapters || {};
  for (const [id, entry] of Object.entries(draftChapters)) {
    const content = typeof entry === 'string' ? entry : String(entry?.content || '');
    chapters[id] = {
      content,
      words: wordCount(content),
      status: content ? 'done' : 'idle',
      updatedAt: entry?.saved_at || draft.updated_at || null,
      local: true,
    };
  }

  for (const node of flat) {
    const chapter = chapters[node.id];
    node.words = chapter ? chapter.words : 0;
    node.status = chapter?.content ? 'done' : chapter?.status === 'running' ? 'running' : 'idle';
    node.local = Boolean(chapter?.local);
  }

  const specFacts = asArray(src.global_facts?.facts || src.globalFacts);
  let facts = specFacts.map((fact) => ({
    key: String(fact.key || fact.title || ''),
    value: String(fact.value || fact.content || ''),
    source: String(fact.source || '招标解析'),
  }));
  let factsLocal = false;
  if (Array.isArray(draft.facts) && draft.facts.length) {
    facts = draft.facts.map((fact) => ({ key: String(fact.key || ''), value: String(fact.value || ''), source: String(fact.source || '本地草稿') }));
    factsLocal = true;
  } else if (!facts.length) {
    facts = deriveFacts(analysisProject, stats);
    factsLocal = facts.length > 0;
  }

  const checks = {
    rejection: meaningfulCheck(src.checks?.rejection || src.rejectionCheck, 'rejection'),
    duplicate: meaningfulCheck(src.checks?.duplicate || src.duplicateCheck, 'duplicate'),
  };

  const deviationSource = src.deviation || null;
  const rows = normalizeDeviationRows({ raw: src, requirements }, deviationSource);
  const draftRows = draft.deviationRows || {};
  let deviationLocal = false;
  for (const row of rows) {
    const override = draftRows[row.id];
    if (!override) continue;
    if (override.response !== undefined) row.response = String(override.response);
    if (override.deviation !== undefined) row.deviation = String(override.deviation);
    row.local = true;
    deviationLocal = true;
  }
  const confirmedByApi = deviationSource?.status === 'confirmed' || deviationSource?.confirmed === true;
  const confirmedLocal = Boolean(draft.deviationConfirmed);
  const deviation = {
    rows,
    status: confirmedByApi ? 'confirmed' : confirmedLocal ? 'confirmed-local' : 'draft',
    local: deviationLocal,
    updatedAt: deviationSource?.confirmed_at || deviationSource?.updated_at || draft.deviationConfirmedAt || null,
    summary: deviationSource?.summary || null,
    generated: rows.some((row) => row.response),
  };

  // 需求条目 ← 偏离表响应（招标解析页签的「响应状态」列）
  const responseByRequirement = new Map();
  for (const row of rows) {
    if (row.requirementId) responseByRequirement.set(row.requirementId, row);
  }
  for (const requirement of requirements) {
    const row = responseByRequirement.get(requirement.id);
    if (row?.response) {
      requirement.deviationResponse = row.response;
      requirement.deviationType = row.deviation;
      requirement.responded = true;
    }
  }

  const totalWordsValue = flat.reduce((sum, node) => sum + (chapters[node.id]?.words || 0), 0)
    || Number(src.content?.total_words || 0);

  return {
    source: src.analysisRaw || src.outlineData ? 'compat' : 'api',
    step: String(src.step || ''),
    updatedAt: src.updatedAt || src.updated_at || null,
    requirements,
    stats,
    analysisProject,
    roots,
    flatNodes: flat,
    chapters,
    totalWords: totalWordsValue,
    facts,
    factsLocal,
    tasks: Array.isArray(src.tasks) ? src.tasks : [
      src.bidAnalysisTask,
      src.outlineGenerationTask,
      src.globalFactsTask,
      src.contentGenerationTask,
    ].filter(Boolean),
    checks,
    deviation,
    exportInfo: src.export || null,
    coverage: src.outline?.coverage || null,
    raw: src,
  };
}

/** 技术方案：新接口 → 兼容接口（X-Project-Id）→ 空状态 */
export async function loadPlan(pid) {
  let raw = null;
  let source = 'api';
  try {
    raw = await api.technicalPlan(pid);
  } catch (error) {
    if (!isMissing(error)) throw error;
    source = 'compat';
    raw = await api.get('/api/technical-plan');
  }
  const plan = normalizePlan(raw, pid);
  plan.source = source === 'compat' ? 'compat' : plan.source;
  return plan;
}

function normalizeQuality(input) {
  let row = input;
  if (Array.isArray(row)) row = row.at(-1) || null;
  if (row && typeof row === 'object' && row.latest) row = row.latest;
  if (!row || typeof row !== 'object') return null;
  const dimensions = row.dimensions || row.dimension || row.dimension_json || null;
  const score = row.score ?? row.total_score ?? row.total ?? null;
  if (score === null && !dimensions) return null;
  return {
    score: score === null ? null : Number(score),
    verdict: row.verdict || null,
    dimensions: dimensions && typeof dimensions === 'object' ? dimensions : null,
    nodeKey: row.node_key || '',
    iteration: row.iteration ?? null,
    createdAt: row.created_at || row.createdAt || null,
    findings: asArray(row.findings || row.findings_json),
    rules: asArray(row.rules),
  };
}

/** latest_run 既可能是运行摘要（node_done/node_total），也可能是 /api/runs/:id 完整快照 */
function normalizeLatestRun(input) {
  if (!input || typeof input !== 'object') return null;
  const run = input.run || input;
  const nodes = asArray(input.nodes);
  const stats = input.stats || null;
  const done = stats?.succeeded ?? run.node_done ?? nodes.filter((node) => node.status === 'succeeded').length;
  const total = stats?.nodes ?? run.node_total ?? nodes.length;
  return {
    run,
    nodes,
    stats,
    quality: normalizeQuality(input.quality),
    progress: { done: Number(done) || 0, total: Number(total) || 0 },
  };
}

/** 空态检查结果（status=idle、无条目）不当作「已检查」 */
function meaningfulCheck(value, kind) {
  if (!value || typeof value !== 'object') return null;
  const status = String(value.status || '');
  if (kind === 'rejection') {
    const items = Array.isArray(value.items) ? value.items : Array.isArray(value.vetoes) ? value.vetoes : [];
    const total = value.veto_count ?? value.stats?.veto_total ?? items.length;
    return status === 'success' || Number(total) > 0 || items.length ? value : null;
  }
  const pairs = Array.isArray(value.pairs) ? value.pairs : [];
  const max = Number(value.max_similarity || 0);
  return status === 'success' || pairs.length > 0 || max > 0 ? value : null;
}

function normalizeWorkspace(raw, project, plan) {
  const ws = raw && typeof raw === 'object' ? raw : {};
  return {
    source: 'api',
    project: ws.project || project || { id: 0, name: '' },
    owner: ws.project?.owner || null,
    runs: asArray(ws.runs || project?.runs),
    latestRun: normalizeLatestRun(ws.latest_run || ws.latestRun),
    pendingReviews: asArray(ws.pending_reviews || ws.pendingReviews),
    quality: normalizeQuality(ws.quality || ws.latest_quality),
    checks: {
      rejection: meaningfulCheck(ws.checks?.rejection, 'rejection') || plan?.checks?.rejection || null,
      duplicate: meaningfulCheck(ws.checks?.duplicate, 'duplicate') || plan?.checks?.duplicate || null,
    },
    exports: asArray(ws.exports),
  };
}

/**
 * 工作台概览数据：新接口 → 由 projects/runs/reviews/quality 聚合。
 * ws.latestRun 是 /api/runs/:id 的完整快照（run/nodes/quality/stats），供节点进度使用。
 */
export async function loadWorkspace(pid, ctx, plan) {
  const cached = ctx?.projects?.find((item) => item.id === pid) || null;
  let detail = null;
  try {
    detail = await api.project(pid);
  } catch (error) {
    if (error?.status !== 403 && error?.status !== 404) throw error;
  }

  try {
    const ws = await api.workspace(pid);
    return normalizeWorkspace(ws, detail || cached, plan);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const project = detail || cached || { id: pid, name: `项目 #${pid}`, code: '' };
  const runs = asArray(detail?.runs);
  const latestMeta = runs[0] || null;
  let latestRun = null;
  if (latestMeta?.id) {
    try { latestRun = await api.run(latestMeta.id); } catch { latestRun = { run: latestMeta }; }
  }
  let pendingReviews = [];
  try { pendingReviews = asArray(await api.reviews({ projectId: pid, status: 'pending' })); } catch { /* 无权限/无数据 */ }
  const quality = normalizeQuality(latestRun?.quality) || normalizeQuality(detail?.quality);

  return {
    source: 'aggregate',
    project,
    runs,
    latestRun: normalizeLatestRun(latestRun),
    pendingReviews,
    quality,
    checks: plan?.checks || { rejection: null, duplicate: null },
    exports: [],
  };
}

export function stepStates(plan, exportsCount = 0) {
  const hasContent = plan.flatNodes.some((node) => (plan.chapters[node.id]?.content || '').length > 0);
  const done = {
    parse: plan.requirements.length > 0,
    outline: plan.flatNodes.length > 0,
    facts: plan.facts.length > 0 && !plan.factsLocal,
    content: hasContent,
    checks: Boolean(plan.checks.rejection || plan.checks.duplicate),
    export: Boolean(plan.exportInfo?.file) || exportsCount > 0,
  };
  let activeAssigned = false;
  return STEP_ORDER.map((key, index) => {
    const isDone = done[key];
    const active = !isDone && !activeAssigned;
    if (active) activeAssigned = true;
    return { key, index: index + 1, label: STEP_META[key].label, done: isDone, active };
  });
}

export function chapterWordTotal(plan) {
  return plan.flatNodes.reduce((sum, node) => sum + (plan.chapters[node.id]?.words || 0), 0);
}

/* --------------------------------------------------------------- 偏离表 */
export function normalizeDeviationPayload(payload, plan) {
  if (!payload) return plan.deviation;
  const source = payload.deviation && typeof payload.deviation === 'object' ? payload.deviation : payload;
  const rows = normalizeDeviationRows(plan, source);
  const draft = readDraft(plan.pid || 0);
  return {
    rows,
    status: source.status === 'confirmed' ? 'confirmed' : draft.deviationConfirmed ? 'confirmed-local' : 'draft',
    local: false,
    updatedAt: source.updated_at || source.confirmed_at || null,
    generated: rows.some((row) => row.response),
  };
}

export async function loadDeviation(pid, plan) {
  plan.pid = pid;
  try {
    const payload = await api.deviation(pid);
    return normalizeDeviationPayload(payload, plan);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return plan.deviation;
}

export async function patchDeviationRow(pid, rowId, body) {
  try {
    await api.patchDeviationRow(pid, encodeURIComponent(rowId), body);
    return { mode: 'api' };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const draft = readDraft(pid);
  const rows = { ...(draft.deviationRows || {}) };
  rows[rowId] = { ...(rows[rowId] || {}), ...body, saved_at: new Date().toISOString() };
  writeDraft(pid, { deviationRows: rows });
  return { mode: 'local' };
}

export async function confirmDeviation(pid) {
  try {
    const result = await api.confirmDeviation(pid);
    return { mode: 'api', result };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  writeDraft(pid, { deviationConfirmed: true, deviationConfirmedAt: new Date().toISOString() });
  return { mode: 'local' };
}

export async function generateDeviation(pid) {
  try {
    const result = await api.generateDeviation(pid);
    return { mode: 'api', result };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return { mode: 'local' };
}

/* ----------------------------------------------------------- 章节 / 事实 */
export async function saveChapter(pid, nodeId, content) {
  try {
    await api.saveChapter(pid, nodeId, content);
    return { mode: 'api' };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const draft = readDraft(pid);
  const chapters = { ...(draft.chapters || {}) };
  chapters[nodeId] = { content, saved_at: new Date().toISOString() };
  writeDraft(pid, { chapters });
  return { mode: 'local' };
}

export function saveFactsLocal(pid, facts) {
  writeDraft(pid, { facts });
  return facts;
}

/* ----------------------------------------------------------------- 导出 */
export async function loadExports(pid) {
  try {
    const rows = await api.exports(pid);
    const items = asArray(rows).map((row) => ({
      id: row.id,
      fileName: row.file_name || row.file || 'export.docx',
      bytes: Number(row.bytes || 0),
      createdAt: row.created_at || row.createdAt || null,
      downloadUrl: row.download_url || row.path || (row.file_name ? `/files/${row.file_name}` : row.file || ''),
      validation: row.validation_json || row.validation || null,
      sha256: row.sha256 || '',
    }));
    return { source: 'api', items };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  const local = asArray(readDraft(pid).exports);
  return { source: 'local', items: local };
}

export function recordLocalExport(pid, entry) {
  const draft = readDraft(pid);
  const items = [entry, ...asArray(draft.exports)].slice(0, 20);
  writeDraft(pid, { exports: items });
  return items;
}

/* ----------------------------------------------------------------- 步骤 */
/**
 * 触发单步：新接口 → 兼容 tasks/start-* → 本地。
 * 返回 { mode: 'api'|'compat'|'local', task?, result?, blocked? }
 */
export async function runStep(pid, step, options = {}) {
  const meta = STEP_META[step];
  if (!meta) throw new Error(`未知步骤：${step}`);

  try {
    if (step === 'duplicate' || step === 'rejection') {
      // 两项检查各有独立入口（可只跑其中一项）
      const result = await api.runCheck(pid, step);
      return { mode: 'api', task: result?.task || null, result };
    }
    const task = await api.planStep(pid, step, options);
    return { mode: 'api', task: task?.task || task, result: task };
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  if (step === 'facts') {
    // 全局事实：新接口缺失时由招标解析结果本地推导，界面标注「本地推导」
    return { mode: 'local', task: null };
  }
  if (step === 'export') {
    const result = await api.exportDocx(pid);
    return { mode: 'compat', result };
  }
  if (meta.compat) {
    const task = await api.startTask(meta.compat, { projectId: pid });
    return { mode: 'compat', task };
  }
  throw new Error(`步骤未实现：${meta.label}`);
}

/**
 * 观察项目任务结束：先立即读一次（新版 startStep 同步执行，通常当场已结束），
 * 若仍有运行中任务再按 intervalMs 轮询，最多 timeoutMs。可被 track() 清理。
 */
export function pollTask({ onTick, timeoutMs = 60000, intervalMs = 1200 } = {}) {
  let stopped = false;
  let timer = null;
  let resolveFn = null;
  const promise = new Promise((resolve) => { resolveFn = resolve; });
  const started = Date.now();
  const finish = (task) => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    resolveFn(task);
  };
  const tick = async () => {
    if (stopped) return;
    let list = [];
    try {
      list = asArray(await api.taskActive());
    } catch {
      finish(null);
      return;
    }
    const task = list[0] || null;
    onTick?.(task, { elapsed: Date.now() - started });
    if (task && task.status === 'error') { finish(task); return; }
    if (!task) { finish(null); return; }
    if (Date.now() - started > timeoutMs) { finish(task); return; }
  };
  timer = setInterval(tick, intervalMs);
  tick();
  return {
    promise,
    stop() { stopped = true; if (timer) clearInterval(timer); },
  };
}


