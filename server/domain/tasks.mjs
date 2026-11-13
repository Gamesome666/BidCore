// 任务/工作区领域：把 yibiao 的「单文档全量 state + 九个 tasks/start-*」压缩成
// 一颗 project_state 树 + 一条可重放的六步流水线（parse → outline → facts → content → checks → deviation → export）。
//
// 设计要点：
//  · 唯一写入口 mutateState()：所有步骤都在同一个事务里读改写 project_state.data_json，避免并发写坏；
//  · 同项目同步骤在飞时直接返回那个 task（deduped:true），重复点击不会双写；
//  · 旧兼容层（/api/tasks/start-*、/api/technical-plan、/api/export/docx）复用这里的 startStep/exportProjectDocx，
//    因此新旧两条链路看到的是同一份数据，而不是两套假数据；
//  · 全部内容由项目名/招标原文派生（不使用随机数），smoke 可复现。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, get, run, tx, jparse, jstr, VAR_DIR } from '../db.mjs';
import { id, nowIso, clip, sha256 } from '../lib/util.mjs';
import { publish } from '../lib/bus.mjs';
import { writeDocx } from './docx.mjs';
import { loadSettings } from '../seed.mjs';
import { generateText, llmStatus } from './llm.mjs';
import {
  parseBidAnalysis, toLegacyAnalysis, buildOutlineTree, toLegacyOutline, outlineLeaves,
  buildGlobalFacts, writeChapter, joinChapters, countChars, primaryOwnerMap,
  checkRejection, checkDuplicate, buildDeviationRows, validateExport, composeProjectMarkdown,
  checkCompliance, duplicateReport,
} from './bid.mjs';
import { buildQualificationPack, attachKnowledgeRefs } from './qualification.mjs';

/** 业务错误：路由层据此转成 4xx（而不是 500） */
export class StepError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

export const STEP_ORDER = ['parse', 'outline', 'facts', 'content', 'checks', 'deviation', 'export'];

const STEP_ALIAS = {
  parse: 'parse', parsed: 'parse', 'bid-analysis': 'parse', analysis: 'parse', 招标解析: 'parse',
  outline: 'outline', outlined: 'outline', 'outline-generation': 'outline', 目录: 'outline',
  facts: 'facts', 'global-facts': 'facts', 'global-facts-generation': 'facts', global_facts: 'facts', 事实: 'facts',
  content: 'content', 'content-generation': 'content', chapters: 'content', 正文: 'content',
  checks: 'checks', check: 'checks', 'rejection-check': 'checks', 'duplicate-analysis': 'checks', 检查: 'checks',
  deviation: 'deviation', 'response-deviation': 'deviation', 'response-deviation-generation': 'deviation', 偏离: 'deviation',
  export: 'export', exported: 'export', 'export-word': 'export', docx: 'export', 导出: 'export',
  all: 'all',
};

export function normalizeStep(input) {
  const key = String(input ?? '').trim().toLowerCase();
  return STEP_ALIAS[key] || null;
}

const STEP_RANK = { idle: 0, parsed: 1, outlined: 2, facts: 3, content: 4, checked: 5, deviated: 6, exported: 7 };

export function advanceStep(current, next) {
  const a = STEP_RANK[current] ?? 0;
  const b = STEP_RANK[next] ?? 0;
  return b >= a ? next : current;
}

/* ───────────────────────────── project_state 形状 ───────────────────────────── */

function emptyBidAnalysis() {
  return { status: 'idle', requirements: [], summary: '', stats: {}, project_meta: {}, scoring: [], vetoes: [] };
}

function emptyOutline() {
  return { status: 'idle', nodes: [], leaves: [], coverage: { required: 0, covered: 0, missing: [] } };
}

function emptyFacts() {
  return { status: 'idle', facts: [] };
}

function emptyContent() {
  return {
    status: 'idle', progress: 0,
    chapters: {}, markdown_by_node: {},
    sections: [], markdown: '', total_words: 0, word_count: 0,
  };
}

function emptyChecks() {
  return {
    rejection: { status: 'idle', veto_count: 0, items: [], summary: '' },
    duplicate: { status: 'idle', max_similarity: 0, pairs: [], summary: '' },
  };
}

function emptyDeviation() {
  return { status: 'empty', confirmed: false, rows: [], summary: { total: 0 } };
}

function emptyExport() {
  return { status: 'idle', file: '', download_url: '', bytes: 0, sha256: '', validation: { ok: false, blockers: [] } };
}

export function emptyState() {
  return {
    workflowKind: 'technical-plan',
    step: 'idle',
    bid_analysis: emptyBidAnalysis(),
    outline: emptyOutline(),
    global_facts: emptyFacts(),
    content: emptyContent(),
    checks: emptyChecks(),
    deviation: emptyDeviation(),
    export: emptyExport(),
    // 旧形态镜像（/api/technical-plan、workbench、engine 老视图还在读这些键）
    analysisRaw: null,
    outlineData: null,
    rejectionCheck: null,
    duplicateCheck: null,
    projectOverview: '',
    techRequirements: '',
  };
}

function mergeState(stored) {
  const base = emptyState();
  const source = stored && typeof stored === 'object' ? stored : {};
  const next = { ...base, ...source };
  for (const key of ['bid_analysis', 'outline', 'global_facts', 'content', 'deviation', 'export']) {
    next[key] = { ...base[key], ...(source[key] || {}) };
  }
  next.checks = {
    rejection: { ...base.checks.rejection, ...(source.checks?.rejection || {}) },
    duplicate: { ...base.checks.duplicate, ...(source.checks?.duplicate || {}) },
  };
  if (!next.updatedAt) next.updatedAt = nowIso();
  return next;
}

export function projectState(projectId) {
  const row = get('SELECT data_json FROM project_state WHERE project_id = ?', projectId);
  return mergeState(jparse(row?.data_json, {}));
}

function writeState(projectId, state) {
  const next = { ...state, updatedAt: nowIso() };
  run(
    `INSERT INTO project_state (project_id, data_json, updated_at) VALUES (?,?,?)
     ON CONFLICT(project_id) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at`,
    projectId, jstr(next), nowIso(),
  );
  return next;
}

export function saveProjectState(projectId, patch) {
  return tx(() => {
    const current = projectState(projectId);
    return writeState(projectId, { ...current, ...patch });
  });
}

/** 唯一写入口：读 → 改 → 事务写（所有步骤都走这里） */
export function mutateState(projectId, mutator) {
  return tx(() => {
    const current = projectState(projectId);
    const draft = structuredClone(current);
    const result = mutator(draft) ?? draft;
    return writeState(projectId, result);
  });
}

function emitState(projectId, step) {
  publish(projectId, 'workflow', { type: 'project.state', project_id: projectId, step });
}

/* ───────────────────────────── tasks 表 / SSE ───────────────────────────── */

export function shapedTask(row, extra = {}) {
  if (!row) return null;
  return {
    id: row.id,
    task_id: row.id,
    type: row.type,
    status: row.status,
    progress: row.progress,
    logs: jparse(row.logs_json, []),
    started_at: row.started_at,
    updated_at: row.updated_at,
    error: row.error ?? undefined,
    stats: jparse(row.stats_json, null),
    pause_requested: false,
    ...extra,
  };
}

function updateTask(projectId, taskId, patch = {}) {
  const current = get('SELECT * FROM tasks WHERE id=?', taskId);
  if (!current) return null;
  const logs = patch.logs ?? jparse(current.logs_json, []);
  if (patch.log) logs.push(String(patch.log));
  run(
    'UPDATE tasks SET status=?, progress=?, logs_json=?, stats_json=?, error=?, updated_at=? WHERE id=?',
    patch.status ?? current.status,
    patch.progress ?? current.progress,
    jstr(logs.slice(-40)),
    jstr(patch.stats !== undefined ? patch.stats : jparse(current.stats_json, null)),
    patch.error !== undefined ? patch.error : current.error,
    nowIso(),
    taskId,
  );
  const shaped = shapedTask(get('SELECT * FROM tasks WHERE id=?', taskId));
  publish(projectId, 'tasks', { type: 'task.updated', task: shaped });
  return shaped;
}

export function listActiveTasks(projectId) {
  return all("SELECT * FROM tasks WHERE project_id=? AND status IN ('running','pausing') ORDER BY started_at DESC", projectId)
    .map((row) => shapedTask(row));
}

/* ───────────────────────────── 前置条件 ───────────────────────────── */

function prerequisites(projectId, step) {
  const project = get('SELECT * FROM projects WHERE id=?', projectId);
  if (!project) return { ok: false, code: 'PROJECT_NOT_FOUND', message: '项目不存在', status: 404 };
  const state = projectState(projectId);
  if (step === 'parse' || step === 'all') {
    if (!String(project.tender_text || '').trim()) {
      return { ok: false, code: 'TENDER_REQUIRED', message: '项目还没有招标文件文本，请先粘贴或上传招标文件', status: 400 };
    }
    return { ok: true, project, state };
  }
  // 导出不做前置抛错：交给 validateExport 产出 blockers（前端要展示"缺什么"，而不是一个 400）
  if (step === 'export') return { ok: true, project, state };
  if (!(state.bid_analysis?.requirements || []).length) {
    return { ok: false, code: 'ANALYSIS_REQUIRED', message: '请先完成招标解析（step=parse）', status: 400 };
  }
  const needsOutline = ['content', 'checks', 'deviation'].includes(step);
  if (needsOutline && !(state.outline?.nodes || []).length) {
    return { ok: false, code: 'OUTLINE_REQUIRED', message: '请先生成/保存技术方案目录（step=outline）', status: 400 };
  }
  return { ok: true, project, state };
}

/* ───────────────────────────── 各步骤实现 ───────────────────────────── */

function refreshResponses(analysis, outline, contentText) {
  const owner = primaryOwnerMap(outline);
  const requirements = (analysis.requirements || []).map((req) => {
    const tokens = (req.metrics?.length ? req.metrics : req.keywords) || [];
    const hit = tokens.length
      ? tokens.some((t) => contentText.includes(t))
      : ['保证金', '报价', '资格', '证书', '偏离表', '7×24', '承诺', '响应'].some((t) => contentText.includes(t));
    return {
      ...req,
      responded: Boolean(hit),
      response: hit ? `满足：见 ${owner.get(req.id) || '技术方案正文'}` : '',
    };
  });
  return { ...analysis, requirements };
}

function summaryOverview(analysis) {
  const meta = analysis.project_meta || {};
  return [meta.name, meta.code ? `采购编号 ${meta.code}` : '', meta.budget ? `预算 ${meta.budget}` : '', meta.duration ? `工期 ${meta.duration}` : '']
    .filter(Boolean)
    .join('｜');
}

async function runParse(projectId, taskId, options = {}) {
  const project = get('SELECT * FROM projects WHERE id=?', projectId);
  updateTask(projectId, taskId, { progress: 8, log: `读取招标文件（${countChars(project.tender_text)} 字）…` });
  const analysis = parseBidAnalysis({ text: project.tender_text, project });
  const legacy = toLegacyAnalysis(analysis);
  updateTask(projectId, taskId, {
    progress: 60,
    log: `抽取要求 ${analysis.requirements.length} 条（废标 ${analysis.stats.veto} / 资格 ${analysis.stats.qualification} / 技术 ${analysis.stats.technical}）`,
  });

  mutateState(projectId, (state) => {
    const sameSource = state.bid_analysis?.source?.chars === analysis.source.chars
      && (state.bid_analysis?.requirements || []).length === analysis.requirements.length;
    state.bid_analysis = analysis;
    state.analysisRaw = legacy;
    state.projectOverview = summaryOverview(analysis);
    state.techRequirements = analysis.requirements
      .filter((r) => r.category_key === 'technical')
      .map((r) => `${r.id} ${r.text}`)
      .join('\n');
    state.step = 'parsed';
    state.workflowKind = state.workflowKind || 'technical-plan';
    if (!sameSource) {
      // 招标原文变了：下游全部失效（对齐 yibiao "清空下游技术方案状态"）
      state.outline = emptyOutline();
      state.outlineData = null;
      state.global_facts = emptyFacts();
      state.content = emptyContent();
      state.checks = emptyChecks();
      state.rejectionCheck = null;
      state.duplicateCheck = null;
      state.deviation = emptyDeviation();
      state.export = emptyExport();
    }
    return state;
  });
  emitState(projectId, 'parsed');
  return { stats: analysis.stats, log: `解析完成：${analysis.summary}` };
}

function preservedMarkdownByTitle(state) {
  const prev = state.content?.markdown_by_node || {};
  const nodes = state.outline?.nodes || [];
  const map = new Map();
  for (const node of nodes) {
    if (prev[node.id]) map.set(node.title, prev[node.id]);
  }
  return map;
}

async function runOutline(projectId, taskId, options = {}) {
  const state = projectState(projectId);
  if (!(state.bid_analysis?.requirements || []).length) {
    throw new StepError('ANALYSIS_REQUIRED', '请先完成招标解析', 400);
  }
  updateTask(projectId, taskId, { progress: 20, log: '按评分办法与技术条款生成层级目录…' });
  const outline = buildOutlineTree(state.bid_analysis);
  const legacyOutline = toLegacyOutline(outline);
  const keptByTitle = preservedMarkdownByTitle(state);

  updateTask(projectId, taskId, {
    progress: 70,
    log: `目录生成：${outline.nodes.length} 个节点 / ${outline.leaves.length} 个叶子，覆盖 ${outline.coverage.covered}/${outline.coverage.required} 条关键要求`,
  });

  mutateState(projectId, (draft) => {
    draft.outline = outline;
    draft.outlineData = legacyOutline;
    draft.step = advanceStep(draft.step, 'outlined');
    // 重建正文映射：保留同标题章节，其余清空（结构变了就别留半截数据）
    const markdownByNode = {};
    for (const leaf of outlineLeaves(outline.nodes)) {
      if (keptByTitle.has(leaf.title)) markdownByNode[leaf.id] = keptByTitle.get(leaf.title);
    }
    const content = emptyContent();
    if (Object.keys(markdownByNode).length) {
      content.markdown_by_node = markdownByNode;
      content.chapters = Object.fromEntries(Object.entries(markdownByNode).map(([nodeId, md]) => [nodeId, { status: 'done', word_count: countChars(md), updated_at: nowIso() }]));
      content.sections = outlineLeaves(outline.nodes)
        .filter((leaf) => markdownByNode[leaf.id])
        .map((leaf) => ({ id: leaf.id, no: leaf.number, title: leaf.title, content: markdownByNode[leaf.id], words: countChars(markdownByNode[leaf.id]), refs: { requirements: leaf.requirement_ids, knowledge: [] }, traceable: true }));
      content.markdown = joinChapters(outline, markdownByNode);
      content.total_words = Object.values(markdownByNode).reduce((sum, md) => sum + countChars(md), 0);
      content.word_count = content.total_words;
      content.status = 'success';
      content.progress = 100;
    }
    draft.content = content;
    draft.checks = emptyChecks();
    draft.rejectionCheck = null;
    draft.duplicateCheck = null;
    draft.export = emptyExport();
    return draft;
  });
  emitState(projectId, 'outlined');
  return {
    stats: { nodes: outline.nodes.length, leaves: outline.leaves.length, coverage: outline.coverage },
    log: `目录完成：${outline.nodes.length} 节点（覆盖 ${outline.coverage.covered}/${outline.coverage.required}）`,
  };
}

async function runFacts(projectId, taskId, options = {}) {
  const project = get('SELECT * FROM projects WHERE id=?', projectId);
  const state = projectState(projectId);
  updateTask(projectId, taskId, { progress: 30, log: '提炼工期/质保/报价口径等全局事实…' });
  const facts = buildGlobalFacts({ analysis: state.bid_analysis, project, text: project?.tender_text || '' });
  mutateState(projectId, (draft) => {
    draft.global_facts = facts;
    draft.step = advanceStep(draft.step, 'facts');
    return draft;
  });
  emitState(projectId, 'facts');
  return { stats: { facts: facts.facts.length }, log: `全局事实 ${facts.facts.length} 条` };
}

function chapterPrompt(node, requirements, facts) {
  return [
    `请为投标技术方案的章节「${node.number} ${node.title}」撰写正文。`,
    '要求：Markdown 段落，200 字以上；逐条响应下列招标要求，不写空话，不出现"待补充/TODO"占位符。',
    requirements.map((r) => `- ${r.id} ${r.text}`).join('\n'),
    facts.slice(0, 4).map((f) => `- 口径 ${f.key}：${f.value}`).join('\n'),
  ].join('\n');
}

async function runContent(projectId, taskId, options = {}) {
  const project = get('SELECT * FROM projects WHERE id=?', projectId);
  const state = projectState(projectId);
  const outline = state.outline;
  const analysis = state.bid_analysis;
  const leaves = outlineLeaves(outline.nodes || []);
  if (!leaves.length) throw new StepError('OUTLINE_REQUIRED', '请先生成技术方案目录', 400);

  const facts = (state.global_facts?.facts || []).length
    ? state.global_facts.facts
    : buildGlobalFacts({ analysis, project, text: project?.tender_text || '' }).facts;
  const bidder = project?.bidder_name || '我方';
  const byId = new Map((analysis.requirements || []).map((r) => [r.id, r]));
  const status = llmStatus();
  const useLlm = options.llm === true && status.mode === 'openai' && status.ready;

  const markdownByNode = {};
  const chapters = {};
  let total = 0;
  let minWords = Infinity;

  for (let i = 0; i < leaves.length; i += 1) {
    const leaf = leaves[i];
    const reqs = (leaf.requirement_ids || []).map((rid) => byId.get(rid)).filter(Boolean);
    let markdown = writeChapter({ node: leaf, requirements: reqs, facts, project: analysis.project_meta || {}, bidder, index: i });
    if (useLlm) {
      markdown = await generateText({
        system: '你是资深投标技术方案主笔，输出严谨、可核验的中文 Markdown 正文，不编造资质与业绩。',
        user: chapterPrompt(leaf, reqs, facts),
        fallback: markdown,
      });
    }
    const words = countChars(markdown);
    markdownByNode[leaf.id] = markdown;
    chapters[leaf.id] = { status: 'done', word_count: words, updated_at: nowIso() };
    total += words;
    minWords = Math.min(minWords, words);
    if (i === 0 || (i + 1) % 4 === 0 || i === leaves.length - 1) {
      updateTask(projectId, taskId, {
        progress: Math.min(95, 10 + Math.round(((i + 1) / leaves.length) * 80)),
        log: `已生成 ${i + 1}/${leaves.length} 节：${leaf.number} ${leaf.title}（${words} 字）`,
      });
    }
  }

  const contentText = Object.values(markdownByNode).join('\n');
  const refreshed = refreshResponses(analysis, outline, contentText);
  const sections = leaves.map((leaf) => ({
    id: leaf.id, no: leaf.number, title: leaf.title,
    content: markdownByNode[leaf.id], words: countChars(markdownByNode[leaf.id]),
    refs: { requirements: leaf.requirement_ids || [], knowledge: [] },
    traceable: (leaf.requirement_ids || []).length > 0,
  }));

  mutateState(projectId, (draft) => {
    draft.outline.nodes = draft.outline.nodes.map((node) => {
      if (markdownByNode[node.id]) {
        return { ...node, word_count: countChars(markdownByNode[node.id]), status: 'done' };
      }
      return node;
    });
    draft.bid_analysis = refreshed;
    draft.analysisRaw = toLegacyAnalysis(refreshed);
    draft.content = {
      status: 'success',
      progress: 100,
      chapters,
      markdown_by_node: markdownByNode,
      sections,
      markdown: joinChapters(outline, markdownByNode),
      total_words: total,
      word_count: total,
      stats: { leaves: leaves.length, min_words: Number.isFinite(minWords) ? minWords : 0, avg_words: leaves.length ? Math.round(total / leaves.length) : 0, llm: useLlm ? 'openai' : 'deterministic' },
      generated_at: nowIso(),
    };
    draft.step = advanceStep(draft.step, 'content');
    draft.export = emptyExport();
    return draft;
  });
  emitState(projectId, 'content');
  return {
    stats: { leaves: leaves.length, total_words: total, min_words: Number.isFinite(minWords) ? minWords : 0, llm: useLlm ? 'openai' : 'deterministic' },
    log: `正文完成：${leaves.length} 节 / ${total} 字（最短 ${Number.isFinite(minWords) ? minWords : 0} 字）`,
  };
}

async function runChecks(projectId, taskId, options = {}) {
  const state = projectState(projectId);
  const outline = state.outline;
  const analysis = state.bid_analysis;
  if (!(analysis?.requirements || []).length) throw new StepError('ANALYSIS_REQUIRED', '请先完成招标解析', 400);

  const kinds = (options.kinds || []).filter((k) => ['rejection', 'duplicate'].includes(k));
  const wanted = kinds.length ? kinds : ['rejection', 'duplicate'];
  const markdownByNode = state.content?.markdown_by_node || {};
  const contentText = joinChapters(outline, markdownByNode);
  const threshold = Number(loadSettings().quality?.thresholds?.duplicateSimilarity ?? 0.72);

  updateTask(projectId, taskId, { progress: 20, log: `执行检查：${wanted.join(' / ')}` });

  const checks = {
    rejection: state.checks?.rejection?.status === 'idle' ? { status: 'idle' } : state.checks.rejection,
    duplicate: state.checks?.duplicate?.status === 'idle' ? { status: 'idle' } : state.checks.duplicate,
  };
  if (wanted.includes('rejection')) {
    checks.rejection = checkRejection({ analysis, contentText });
    updateTask(projectId, taskId, { progress: 55, log: `废标检查：${checks.rejection.summary}` });
  }
  if (wanted.includes('duplicate')) {
    checks.duplicate = checkDuplicate({ outline, markdownByNode, threshold });
    updateTask(projectId, taskId, { progress: 80, log: `查重：${checks.duplicate.summary}` });
  }

  // 旧形态镜像：workbench / 旧前端仍在读 rejectionCheck、duplicateCheck
  const legacyAnalysis = state.analysisRaw || toLegacyAnalysis(analysis);
  const legacyContent = { sections: state.content?.sections || [], markdown: state.content?.markdown || contentText };
  const legacyRejection = checkCompliance({ analysis: legacyAnalysis, knowledge: { hits: [] }, content: legacyContent, commercial: null });
  const legacyDuplicate = duplicateReport(legacyContent);

  mutateState(projectId, (draft) => {
    draft.checks = checks;
    draft.rejectionCheck = legacyRejection;
    draft.duplicateCheck = legacyDuplicate;
    draft.step = advanceStep(draft.step, 'checked');
    return draft;
  });
  emitState(projectId, 'checked');
  return {
    stats: { rejection: checks.rejection.stats || {}, duplicate: checks.duplicate.stats || {} },
    log: `检查完成：${checks.rejection.summary || ''}${checks.duplicate.summary ? `；${checks.duplicate.summary}` : ''}`,
  };
}

async function runDeviation(projectId, taskId, options = {}) {
  const state = projectState(projectId);
  const analysis = state.bid_analysis;
  const outline = state.outline;
  const markdownByNode = state.content?.markdown_by_node || {};
  const contentText = joinChapters(outline, markdownByNode);
  updateTask(projectId, taskId, { progress: 35, log: '按条款生成技术响应与偏离表…' });
  const deviation = buildDeviationRows({ analysis, outline, markdownByNode, contentText });
  updateTask(projectId, taskId, { progress: 85, log: `偏离表 ${deviation.rows.length} 行（待人工确认）` });
  mutateState(projectId, (draft) => {
    draft.deviation = deviation;
    draft.step = advanceStep(draft.step, 'deviated');
    draft.export = emptyExport();
    return draft;
  });
  emitState(projectId, 'deviated');
  return { stats: deviation.summary, log: `偏离表生成：${deviation.rows.length} 行，等待人工确认` };
}

function exportFileName(projectId) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  return `bidcore-p${projectId}-${stamp}.docx`;
}

/** 导出（校验 → 渲染 → 落盘 → 记档）；返回 { ok, validation, record } */
export function createProjectExport(projectId, user = null) {
  const project = get('SELECT * FROM projects WHERE id=?', projectId);
  if (!project) throw new StepError('PROJECT_NOT_FOUND', '项目不存在', 404);
  const state = projectState(projectId);
  const validation = validateExport({ project, state });
  if (!validation.ok) return { ok: false, validation };

  // 商务/资格证据链：按招标「第三章 资格审查」条款检索知识库，回写 refs.knowledge
  const pack = buildQualificationPack({ project, state });
  const stateWithPack = mutateState(projectId, (draft) => {
    draft.qualification_pack = pack.summary;
    attachKnowledgeRefs(draft.outline, pack.refs);

    // 存量数据自愈（老项目正文里缓存了旧模板句/被表格污染的事实，导出时兜底修正）
    const nodeMarkdown = draft.content?.markdown_by_node || {};
    const LEGACY_CERT_SENTENCE = /资格类证书（[^）]{0,80}）均在有效期内/g;
    const CERT_REPLACEMENT = '资格类证书按招标文件《第三章 资格审查》逐项提供，证书名称、编号与有效期见《附录C 商务资格与证明材料》';
    for (const [nodeId, body] of Object.entries(nodeMarkdown)) {
      if (typeof body === 'string' && body.includes('资格类证书（')) {
        nodeMarkdown[nodeId] = body.replace(LEGACY_CERT_SENTENCE, CERT_REPLACEMENT);
      }
    }

    // 事实被「改编清单」表格行污染时：重算事实，并把正文里嵌着的旧值替换成新值
    const factsBefore = draft.global_facts?.facts || [];
    const polluted = factsBefore.some((fact) => /^A-\d{2}\b/.test(String(fact.value || '')) || String(fact.value || '').includes('\t'));
    if (polluted) {
      const rebuilt = buildGlobalFacts({
        analysis: draft.bid_analysis || {},
        project,
        text: project.tender_text || '',
      });
      const freshByKey = new Map(rebuilt.facts.map((fact) => [fact.key, fact.value]));
      const replacements = factsBefore
        .filter((fact) => /^A-\d{2}\b/.test(String(fact.value || '')) || String(fact.value || '').includes('\t'))
        .map((fact) => [String(fact.value), String(freshByKey.get(fact.key) || '')])
        .filter(([oldValue, newValue]) => oldValue && newValue && oldValue !== newValue);
      draft.global_facts = rebuilt;
      for (const [nodeId, body] of Object.entries(nodeMarkdown)) {
        if (typeof body !== 'string') continue;
        let next = body;
        for (const [oldValue, newValue] of replacements) next = next.split(oldValue).join(newValue);
        if (next !== body) nodeMarkdown[nodeId] = next;
      }
    }

    // 正文里残留的「改编清单」行（A-01 原厂/驻场、A-06 质保期这类）统一洗掉，
    // 避免表格行原样进正式标书；能定位到事实键的，用修正后的事实值替换。
    const factMap = new Map((draft.global_facts?.facts || []).map((fact) => [fact.key, fact.value]));
    const WATERMARK = /演示改编稿\s*·?\s*非采购人发布的正式文件\s*·?\s*不得用于实际投标|演示改编稿|演示用虚构样本/g;
    const BOILERPLATE = /演示改编稿|非采购人发布的正式文件|不得用于实际投标|演示用虚构样本/;
    // 存量解析结果里被当成条款的演示水印，一并从需求列表与偏离表剔除
    if (Array.isArray(draft.bid_analysis?.requirements)) {
      draft.bid_analysis.requirements = draft.bid_analysis.requirements.filter((req) => !BOILERPLATE.test(String(req.text || '')));
    }
    if (Array.isArray(draft.analysisRaw?.requirements)) {
      draft.analysisRaw.requirements = draft.analysisRaw.requirements.filter((req) => !BOILERPLATE.test(String(req.text || '')));
    }
    if (Array.isArray(draft.deviation?.rows)) {
      draft.deviation.rows = draft.deviation.rows.filter((row) => !BOILERPLATE.test(String(row.requirement || '')));
    }
    for (const [nodeId, body] of Object.entries(nodeMarkdown)) {
      if (typeof body !== 'string') continue;
      let cleaned = body;
      if (cleaned.includes('A-0')) {
        cleaned = cleaned
          .replace(/（依据：[^）]*A-0\d[^）]*）\s*/g, '')
          .replace(/(质保期|驻场团队)\s*A-0\d[^。；\n]{0,200}/g, (_m, key) => `${key}：${factMap.get(key) || '按招标文件约定'}`)
          .replace(/A-0\d[^。；\n]{0,200}/g, '按招标文件约定');
      }
      cleaned = cleaned
        .replace(WATERMARK, '')
        .replace(/：\s*。/g, '。')
        .replace(/；\s*；/g, '；')
        .replace(/\d+\)\s*；/g, '')
        .replace(/：\s*；/g, '：');
      if (cleaned !== body) nodeMarkdown[nodeId] = cleaned;
    }
    return draft;
  });

  const markdown = composeProjectMarkdown({ project, state: stateWithPack, extras: { qualificationMarkdown: pack.markdown } });
  const fileName = exportFileName(projectId);
  const filePath = path.join(VAR_DIR, 'files', fileName);
  const { size } = writeDocx(filePath, markdown, { title: `${project.name} 技术方案`, author: project.bidder_name || 'BidCore' });
  const buffer = fs.readFileSync(filePath);
  const digest = crypto.createHash('sha256').update(buffer).digest('hex');
  const exportId = id('exp');
  run(
    'INSERT INTO exports (id, project_id, run_id, file_name, path, bytes, sha256, validation_json, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    exportId, projectId, null, fileName, filePath, buffer.length, digest, jstr(validation), user?.id ?? null, nowIso(),
  );

  const record = {
    id: exportId,
    project_id: projectId,
    file: fileName,
    file_name: fileName,
    download_url: `/files/${fileName}`,
    path: filePath,
    bytes: buffer.length,
    size: buffer.length || size,
    sha256: digest,
    validation,
    created_at: nowIso(),
  };

  mutateState(projectId, (draft) => {
    draft.export = {
      status: 'success',
      id: exportId,
      file: fileName,
      download_url: `/files/${fileName}`,
      bytes: buffer.length,
      sha256: digest,
      validation,
      created_at: record.created_at,
    };
    draft.step = advanceStep(draft.step, 'exported');
    return draft;
  });
  emitState(projectId, 'exported');
  publish(projectId, 'workflow', { type: 'export.ready', project_id: projectId, file: fileName, bytes: buffer.length });
  return { ok: true, validation, record };
}

async function runExport(projectId, taskId, options = {}, user = null) {
  updateTask(projectId, taskId, { progress: 20, log: '导出前置校验…' });
  const result = createProjectExport(projectId, user);
  if (!result.ok) {
    return {
      blocked: true,
      validation: result.validation,
      log: `导出被阻断：${result.validation.blockers.map((b) => b.label).join('、')}`,
    };
  }
  updateTask(projectId, taskId, { progress: 90, log: `Word 已生成：${result.record.file}（${result.record.bytes} bytes）` });
  return {
    stats: { file: result.record.file, bytes: result.record.bytes, sha256: result.record.sha256 },
    validation: result.validation,
    record: result.record,
    log: `导出完成：${result.record.file}`,
  };
}

async function runStepOnce(projectId, step, taskId, options, user) {
  switch (step) {
    case 'parse': return runParse(projectId, taskId, options);
    case 'outline': return runOutline(projectId, taskId, options);
    case 'facts': return runFacts(projectId, taskId, options);
    case 'content': return runContent(projectId, taskId, options);
    case 'checks': return runChecks(projectId, taskId, options);
    case 'deviation': return runDeviation(projectId, taskId, options);
    case 'export': return runExport(projectId, taskId, options, user);
    default: throw new StepError('STEP_INVALID', `未知步骤：${step}`, 400);
  }
}

/* ───────────────────────────── 步骤调度（幂等 + 串行） ───────────────────────────── */

const inflight = new Map();
const chains = new Map();

function enqueue(projectId, fn) {
  const prev = chains.get(projectId) || Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(projectId, next.then(() => undefined, () => undefined));
  return next;
}

async function executeStep(projectId, step, taskId, options, user) {
  if (step !== 'all') return runStepOnce(projectId, step, taskId, options, user);
  let last = null;
  for (let i = 0; i < STEP_ORDER.length; i += 1) {
    const sub = STEP_ORDER[i];
    updateTask(projectId, taskId, {
      progress: Math.round((i / STEP_ORDER.length) * 95),
      log: `▶ 步骤 ${i + 1}/${STEP_ORDER.length}：${sub}`,
    });
    const out = await runStepOnce(projectId, sub, taskId, options, user);
    if (out?.blocked) return out;
    last = out;
  }
  return { ...last, log: `全链路完成（${STEP_ORDER.join(' → ')}）` };
}

/**
 * 启动单步（同步执行；传 {async:true} 则后台执行并立即返回 running task）。
 * 幂等：同项目同步骤在飞 → 直接返回该 task（deduped:true）。
 */
export async function startStep(projectId, rawStep, options = {}, user = null, cfg = {}) {
  const step = normalizeStep(rawStep);
  if (!step) throw new StepError('STEP_INVALID', `未知步骤：${rawStep}（可选 ${STEP_ORDER.join('/')}/all）`, 400);

  const type = cfg.taskType || (step === 'all' ? 'technical-plan:all' : `technical-plan:${step}`);
  const key = `${projectId}|${step}|${type}`;

  if (inflight.has(key)) {
    return { task: inflight.get(key), state: projectState(projectId), deduped: true };
  }
  const running = get("SELECT * FROM tasks WHERE project_id=? AND type=? AND status IN ('running','pausing') ORDER BY started_at DESC LIMIT 1", projectId, type);
  if (running) {
    const task = shapedTask(running, { deduped: true });
    return { task, state: projectState(projectId), deduped: true };
  }

  const pre = prerequisites(projectId, step);
  if (!pre.ok) throw new StepError(pre.code, pre.message, pre.status || 400);

  const taskId = id('task');
  const now = nowIso();
  run(
    'INSERT INTO tasks (id, project_id, type, status, progress, logs_json, payload_json, started_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)',
    taskId, projectId, type, 'running', 1, jstr([`任务已创建：${step}`]), jstr({ step, options }), now, now,
  );
  const created = shapedTask(get('SELECT * FROM tasks WHERE id=?', taskId));
  inflight.set(key, created);
  publish(projectId, 'tasks', { type: 'task.updated', task: created });

  const execute = async () => {
    try {
      const out = await executeStep(projectId, step, taskId, options, user);
      if (out?.blocked) {
        const task = updateTask(projectId, taskId, {
          status: 'error',
          error: 'EXPORT_BLOCKED',
          progress: 100,
          log: out.log,
          stats: { validation: out.validation },
        });
        return { task, state: projectState(projectId), blocked: true, validation: out.validation };
      }
      const task = updateTask(projectId, taskId, {
        status: 'success',
        progress: 100,
        log: out?.log || '完成',
        stats: out?.stats ?? null,
      });
      return {
        task,
        state: projectState(projectId),
        validation: out?.validation,
        record: out?.record,
        blocked: false,
      };
    } catch (error) {
      const code = error instanceof StepError ? error.code : 'STEP_FAILED';
      const task = updateTask(projectId, taskId, {
        status: 'error',
        error: `${code}: ${error.message}`,
        progress: 100,
        log: `失败：${error.message}`,
      });
      if (error instanceof StepError) {
        return { task, state: projectState(projectId), blocked: false, error, httpStatus: error.status };
      }
      throw error;
    } finally {
      inflight.delete(key);
    }
  };

  if (cfg.async || options.async) {
    // 调度窗口：先把 task 行落库并登记 in-flight，再让出事件循环执行，
    // 这样并发的第二次触发会命中 dedupe 分支，而不是双写 project_state。
    setTimeout(() => { execute().catch((error) => console.error('[task]', error)); }, 25);
    return { task: shapedTask(get('SELECT * FROM tasks WHERE id=?', taskId)), state: projectState(projectId), deduped: false };
  }
  return enqueue(projectId, execute);
}

/* ───────────────────────────── 视图 / 保存 / 手工操作 ───────────────────────────── */

export function listRequirements(projectId, { veto = false } = {}) {
  const state = projectState(projectId);
  const requirements = state.bid_analysis?.requirements || [];
  return (veto ? requirements.filter((r) => r.veto) : requirements).map((r) => ({
    id: r.id,
    category: r.category,
    text: r.text,
    veto: Boolean(r.veto),
    weight: r.weight ?? 1,
    response: r.response || '',
    source_ref: r.source_ref,
    responded: Boolean(r.responded),
  }));
}

export function getTechnicalPlanView(projectId) {
  const state = projectState(projectId);
  const project = get('SELECT id, code, name, bidder_name, deadline, budget, industry, owner_id FROM projects WHERE id=?', projectId);
  return {
    project_id: projectId,
    project: project || null,
    step: state.step,
    bid_analysis: state.bid_analysis,
    outline: state.outline,
    global_facts: state.global_facts,
    content: state.content,
    checks: state.checks,
    deviation: state.deviation,
    export: state.export,
    tasks: listActiveTasks(projectId),
    updated_at: state.updatedAt,
  };
}

function computeCoverage(nodes, analysis) {
  const critical = (analysis?.requirements || []).filter((r) => r.veto || (r.weight || 0) >= 2);
  const covered = new Set(nodes.flatMap((n) => n.requirement_ids || []));
  return {
    required: critical.length,
    covered: critical.filter((r) => covered.has(r.id)).length,
    missing: critical.filter((r) => !covered.has(r.id)).map((r) => `${r.id} ${clip(r.text, 24)}`),
  };
}

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五'];

function normalizeOutlineNodes(rawNodes, analysis) {
  const nodes = [];
  const lastAtLevel = [];
  const counters = new Map();
  rawNodes.forEach((raw, i) => {
    const level = Math.min(3, Math.max(1, Number(raw.level) || 1));
    const id = String(raw.id || `n${i + 1}`);
    const parent = level > 1 ? lastAtLevel[level - 2] || null : null;
    const parentKey = parent?.id || 'root';
    const indexInParent = (counters.get(`${parentKey}:${level}`) || 0) + 1;
    counters.set(`${parentKey}:${level}`, indexInParent);
    let number = raw.number ? String(raw.number) : '';
    if (!number) {
      if (level === 1) number = CN_NUM[nodes.filter((n) => n.level === 1).length] || String(indexInParent);
      else number = `${parent?.number || ''}.${indexInParent}`;
    }
    const node = {
      id,
      parent_id: parent?.id ?? null,
      level,
      number,
      title: String(raw.title || `第 ${i + 1} 章`),
      target_words: Number(raw.target_words ?? raw.targetWords ?? 300),
      requirement_ids: Array.isArray(raw.requirement_ids) ? raw.requirement_ids.map(String) : (Array.isArray(raw.requirementIds) ? raw.requirementIds.map(String) : []),
      children: [],
      word_count: Number(raw.word_count ?? 0),
      status: raw.status === 'done' ? 'done' : (raw.word_count ? 'done' : 'empty'),
      content_mode: raw.content_mode || 'ai',
    };
    nodes.push(node);
    if (parent) parent.children.push(id);
    lastAtLevel[level - 1] = node;
    lastAtLevel.length = level;
  });
  return nodes;
}

/** 保存目录（手工编辑）：重建父子关系、覆盖度，并同步旧形态 outlineData */
export function saveOutline(projectId, input) {
  const state = projectState(projectId);
  const analysis = state.bid_analysis;
  const rawNodes = Array.isArray(input) ? input : (input?.nodes || []);
  if (!rawNodes.length) throw new StepError('OUTLINE_EMPTY', '目录不能为空', 400);

  const nodes = normalizeOutlineNodes(rawNodes, analysis);
  const outline = {
    status: 'success',
    nodes,
    leaves: outlineLeaves(nodes).map((n) => n.id),
    coverage: computeCoverage(nodes, analysis),
    generated_at: nowIso(),
    source: 'manual',
  };
  const legacyOutline = toLegacyOutline(outline);
  const leafIds = new Set(outline.leaves);
  const markdownByNode = {};
  for (const [nodeId, md] of Object.entries(state.content?.markdown_by_node || {})) {
    if (leafIds.has(nodeId)) markdownByNode[nodeId] = md;
  }

  const next = mutateState(projectId, (draft) => {
    draft.outline = outline;
    draft.outlineData = legacyOutline;
    draft.content = {
      ...draft.content,
      markdown_by_node: markdownByNode,
      chapters: Object.fromEntries(Object.entries(draft.content?.chapters || {}).filter(([nodeId]) => leafIds.has(nodeId))),
      sections: (draft.content?.sections || []).filter((section) => leafIds.has(section.id)),
      markdown: joinChapters(outline, markdownByNode),
      total_words: Object.values(markdownByNode).reduce((sum, md) => sum + countChars(md), 0),
    };
    draft.content.word_count = draft.content.total_words;
    draft.step = advanceStep(draft.step, 'outlined');
    draft.export = emptyExport();
    return draft;
  });
  emitState(projectId, next.step);
  return { outline, steps: next.step };
}

/** 保存单章正文：更新字数/状态 + 旧形态 sections + 总字数 */
export function saveChapter(projectId, nodeId, markdown) {
  const state = projectState(projectId);
  const nodes = state.outline?.nodes || [];
  const node = nodes.find((n) => n.id === String(nodeId)) || nodes.find((n) => n.number === String(nodeId));
  if (!node) throw new StepError('CHAPTER_NOT_FOUND', `章节不存在：${nodeId}`, 404);

  const md = String(markdown ?? '');
  const words = countChars(md);

  const next = mutateState(projectId, (draft) => {
    const target = draft.outline.nodes.find((n) => n.id === node.id);
    if (target) {
      target.word_count = words;
      target.status = words ? 'done' : 'empty';
    }
    const content = draft.content;
    content.markdown_by_node = { ...(content.markdown_by_node || {}), [node.id]: md };
    content.chapters = { ...(content.chapters || {}), [node.id]: { status: words ? 'done' : 'idle', word_count: words, updated_at: nowIso() } };
    const existing = (content.sections || []).find((section) => section.id === node.id);
    if (existing) {
      existing.content = md;
      existing.words = words;
      existing.traceable = true;
    } else {
      content.sections = [...(content.sections || []), {
        id: node.id, no: node.number, title: node.title, content: md, words,
        refs: { requirements: node.requirement_ids || [], knowledge: [] }, traceable: true,
      }];
    }
    const leaves = outlineLeaves(draft.outline.nodes);
    content.markdown = joinChapters(draft.outline, content.markdown_by_node);
    content.total_words = leaves.reduce((sum, leaf) => sum + countChars(content.markdown_by_node[leaf.id] || ''), 0);
    content.word_count = content.total_words;
    content.status = content.total_words ? 'success' : 'idle';
    content.progress = content.total_words ? 100 : 0;
    // 手工改章后刷新"要求是否已响应"，避免 requirements 面板停在旧结论
    const refreshed = refreshResponses(draft.bid_analysis, draft.outline, content.markdown);
    draft.bid_analysis = refreshed;
    draft.analysisRaw = toLegacyAnalysis(refreshed);
    draft.step = advanceStep(draft.step, 'content');
    draft.export = emptyExport();
    return draft;
  });
  emitState(projectId, next.step);
  return {
    node: next.outline.nodes.find((n) => n.id === node.id),
    content: next.content,
    step: next.step,
  };
}

export function getDeviation(projectId) {
  const state = projectState(projectId);
  return { ...emptyDeviation(), ...(state.deviation || {}) };
}

/** 编辑偏离行（白名单）；已确认后编辑会自动撤销确认，导出前置校验随之阻断 */
export function patchDeviationRow(projectId, rowId, patch = {}) {
  const state = projectState(projectId);
  const rows = state.deviation?.rows || [];
  const index = rows.findIndex((row) => row.id === String(rowId));
  if (index < 0) throw new StepError('DEVIATION_ROW_NOT_FOUND', `偏离行不存在：${rowId}`, 404);

  const nextRow = { ...rows[index] };
  for (const key of ['response', 'deviation', 'evidence', 'notes']) {
    if (patch[key] !== undefined && patch[key] !== null) nextRow[key] = String(patch[key]);
  }
  nextRow.manual_edited = true;
  nextRow.updated_at = nowIso();

  const updatedRows = rows.map((row, i) => (i === index ? nextRow : row));
  const next = mutateState(projectId, (draft) => {
    draft.deviation = {
      ...draft.deviation,
      rows: updatedRows,
      status: draft.deviation.confirmed ? 'generated' : draft.deviation.status,
      confirmed: false,
      confirmed_at: null,
      summary: {
        ...(draft.deviation.summary || {}),
        total: updatedRows.length,
        no_deviation: updatedRows.filter((r) => r.deviation === '无偏离').length,
        positive: updatedRows.filter((r) => r.deviation === '正偏离').length,
        pending: updatedRows.filter((r) => r.deviation === '待确认').length,
      },
    };
    draft.export = emptyExport();
    return draft;
  });
  emitState(projectId, next.step);
  return { row: nextRow, deviation: next.deviation };
}

/** 人工确认偏离表（导出硬门禁） */
export function confirmDeviation(projectId, user = null) {
  const state = projectState(projectId);
  const rows = state.deviation?.rows || [];
  if (!rows.length) throw new StepError('DEVIATION_EMPTY', '偏离表为空，请先生成', 409);
  const empty = rows.filter((row) => !String(row.response || '').trim());
  if (empty.length) throw new StepError('DEVIATION_INCOMPLETE', `${empty.length} 行缺少响应内容`, 409);

  const next = mutateState(projectId, (draft) => {
    draft.deviation = {
      ...draft.deviation,
      status: 'confirmed',
      confirmed: true,
      confirmed_at: nowIso(),
      confirmed_by: user?.id ?? null,
    };
    draft.step = advanceStep(draft.step, 'deviated');
    draft.export = emptyExport();
    return draft;
  });
  emitState(projectId, next.step);
  publish(projectId, 'workflow', { type: 'project.deviation.confirmed', project_id: projectId });
  return next.deviation;
}

export function listExports(projectId) {
  return all('SELECT * FROM exports WHERE project_id=? ORDER BY created_at DESC LIMIT 50', projectId).map((row) => ({
    id: row.id,
    project_id: row.project_id,
    file: row.file_name,
    file_name: row.file_name,
    download_url: `/files/${row.file_name}`,
    bytes: row.bytes,
    sha256: row.sha256,
    validation: jparse(row.validation_json, {}),
    created_by: row.created_by,
    created_at: row.created_at,
  }));
}

function reviewShape(row) {
  return {
    id: row.id,
    run_id: row.run_id,
    project_id: row.project_id,
    project_name: get('SELECT name FROM projects WHERE id=?', row.project_id)?.name ?? '',
    gate_key: row.gate_key,
    level: row.level,
    level_total: row.level_total,
    status: row.status,
    assignee_id: row.assignee_id,
    sla_due_at: row.sla_due_at,
    overdue: row.status === 'pending' && row.sla_due_at < nowIso(),
    minutes_left: Math.round((new Date(row.sla_due_at).getTime() - Date.now()) / 60000),
  };
}

export function pendingReviews(projectId, limit = 10) {
  return all("SELECT * FROM review_tasks WHERE project_id=? AND status='pending' ORDER BY sla_due_at ASC LIMIT ?", projectId, limit)
    .map(reviewShape);
}

/** 工作台快照：项目 + 状态 + 最近运行 + 待审 + 质量 + 检查 + 导出历史 */
export function workspaceSnapshot(projectId) {
  const state = projectState(projectId);
  const latest = get('SELECT * FROM runs WHERE project_id=? ORDER BY started_at DESC LIMIT 1', projectId);
  let latestRun = null;
  if (latest) {
    const counts = get(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS done FROM node_runs WHERE run_id=?",
      latest.id,
    );
    latestRun = {
      id: latest.id,
      status: latest.status,
      objective: latest.objective,
      plan_version: latest.plan_version,
      started_at: latest.started_at,
      finished_at: latest.finished_at,
      node_done: Number(counts?.done || 0),
      node_total: Number(counts?.total || 0),
    };
  }
  // 项目级最新质量报告：即使最新一条运行尚未跑到质量节点，也应展示项目最近一次评分
  const quality = get(
    `SELECT q.total_score, q.verdict, q.created_at, q.run_id, q.node_key, q.iteration
       FROM quality_reports q JOIN runs r ON r.id = q.run_id
      WHERE r.project_id=? ORDER BY q.created_at DESC LIMIT 1`,
    projectId,
  );
  return {
    state,
    latest_run: latestRun,
    pending_reviews: pendingReviews(projectId),
    quality: quality
      ? {
        total: quality.total_score,
        verdict: quality.verdict,
        created_at: quality.created_at,
        run_id: quality.run_id,
        node_key: quality.node_key,
        iteration: quality.iteration,
      }
      : { total: 0, verdict: '-' },
    checks: {
      rejection: state.checks.rejection,
      duplicate: state.checks.duplicate,
    },
    exports: listExports(projectId).slice(0, 10),
  };
}

/* ───────────────────────────── 旧兼容层入口（行为保持不变） ───────────────────────────── */

const COMPAT_STEP = {
  'bid-analysis': 'parse',
  'outline-generation': 'outline',
  'global-facts-generation': 'facts',
  'content-generation': 'content',
  'rejection-check': 'checks',
  'duplicate-analysis': 'checks',
  'response-deviation-generation': 'deviation',
  'export-word': 'export',
};

export function compatStepOf(type) {
  return COMPAT_STEP[type] || null;
}

/** 旧兼容：启动 start-* 任务（异步执行 + 立即返回 running 态 BackgroundTaskState） */
export async function startCompatTask(projectId, type, payload = {}, user = null) {
  const step = COMPAT_STEP[type];
  if (!step) throw new Error(`执行器尚未注册：${type}`);
  const active = get("SELECT * FROM tasks WHERE project_id=? AND status IN ('running','pausing') LIMIT 1", projectId);
  if (active) throw new Error(`当前项目正在执行「${active.type}」，请完成后再启动`);

  const options = { ...(payload || {}) };
  if (type === 'rejection-check') options.kinds = ['rejection'];
  if (type === 'duplicate-analysis') options.kinds = ['duplicate'];

  const result = await startStep(projectId, step, options, user, { taskType: type, async: true });
  return result.task;
}

export function compatTypeFromPath(pathname) {
  const key = String(pathname || '').replace('/api/tasks/', '');
  return COMPAT_STEP[key] ? key : null;
}

/** 旧兼容：/api/export/docx（同步导出，返回 {file:'/files/x', size, words}） */
export function exportProjectDocx(projectId) {
  const state = projectState(projectId);
  const project = get('SELECT * FROM projects WHERE id=?', projectId);
  if (!project) throw new Error('项目不存在');
  const hasNew = Object.keys(state.content?.markdown_by_node || {}).length > 0;
  if (!hasNew && !state.content?.markdown) throw new Error('请先生成正文');

  const markdown = state.content?.markdown || composeProjectMarkdown({ project, state });
  const header = `# ${project.name}\n投标人：${project.bidder_name || '我方'}　采购编号：${state.bid_analysis?.project_meta?.code || project.code || '-'}\n\n`;
  const file = `compat-${projectId}-${sha256(markdown).slice(0, 8)}.docx`;
  const filePath = path.join(VAR_DIR, 'files', file);
  const { size } = writeDocx(filePath, `${header}${markdown}`, { title: project.name, author: project.bidder_name });
  return { file: `/files/${file}`, size, words: state.content?.total_words || 0 };
}
