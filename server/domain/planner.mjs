// Supervisor：计划器（LLM 可选）+ 确定性校验 + FallbackPlan + 返工规则。
// 关键约束：Supervisor 只产出计划，不写内容；校验失败一律兜底，绝不中断运行。
import { FALLBACK_PLAN, loadSettings } from '../seed.mjs';
import { generateJson, llmStatus } from './llm.mjs';
import { clip } from '../lib/util.mjs';

const AGENT_KEYS = [
  'parse-tender', 'knowledge', 'format', 'doc-plan', 'bid-strategy', 'tech', 'commercial', 'compliance', 'doc', 'doc-preview', 'quality', 'supervisor',
  'qualification-review', 'technical-review', 'material-review', 'other-review', 'legal', 'consistency', 'summary',
];
const NODE_TYPES = ['agent', 'quality', 'human-review', 'export'];

export class PlanInvalid extends Error {}

export function validatePlan(input) {
  const plan = structuredClone(input);
  if (!plan || typeof plan !== 'object') throw new PlanInvalid('plan 必须是对象');
  if (!Array.isArray(plan.nodes) || plan.nodes.length < 3) throw new PlanInvalid('节点数不足（至少 3 个）');
  if (plan.nodes.length > 24) throw new PlanInvalid('节点数超过上限 24');

  const keys = new Set();
  for (const node of plan.nodes) {
    if (!/^[a-z0-9-]{1,48}$/.test(String(node.node_key || ''))) throw new PlanInvalid(`node_key 非法：${node.node_key}`);
    if (keys.has(node.node_key)) throw new PlanInvalid(`node_key 重复：${node.node_key}`);
    keys.add(node.node_key);
    if (!AGENT_KEYS.includes(node.agent_key)) throw new PlanInvalid(`未知 agent_key：${node.agent_key}`);
    if (!NODE_TYPES.includes(node.node_type)) throw new PlanInvalid(`未知 node_type：${node.node_type}`);
    if (node.node_type === 'human-review' && !node.review_policy_key) throw new PlanInvalid('human-review 缺少 review_policy_key');
    if (node.agent_key === 'doc' && node.node_type !== 'export') throw new PlanInvalid('doc 只能是 export 节点');
    if (!Array.isArray(node.depends_on)) throw new PlanInvalid('depends_on 必须是数组');
  }
  for (const node of plan.nodes) {
    for (const dep of node.depends_on) if (!keys.has(dep)) throw new PlanInvalid(`依赖不存在：${dep}`);
  }

  // 拓扑排序查环
  const indeg = new Map(plan.nodes.map((n) => [n.node_key, n.depends_on.length]));
  const adj = new Map(plan.nodes.map((n) => [n.node_key, []]));
  for (const n of plan.nodes) for (const d of n.depends_on) adj.get(d).push(n.node_key);
  const queue = [...indeg.entries()].filter(([, v]) => v === 0).map(([k]) => k);
  let seen = 0;
  while (queue.length) {
    const k = queue.shift();
    seen += 1;
    for (const next of adj.get(k)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (seen !== plan.nodes.length) throw new PlanInvalid('计划存在环');

  const consumed = new Set(plan.nodes.flatMap((n) => n.depends_on));
  const sinks = plan.nodes.filter((n) => !consumed.has(n.node_key));
  if (!sinks.some((n) => n.node_type === 'export')) throw new PlanInvalid('缺少导出终结点');

  plan.plan_version = Number(plan.plan_version || 1);
  if (!plan.budget) plan.budget = { max_tokens: 3000000, max_wall_ms: 14400000, max_agent_calls: 40 };
  return plan;
}

/**
 * 归一化 LLM 产出的计划：模型常返回中文 key、缺少 node_type 或漏掉导出节点。
 * 这里做「可解释的机械修复」——只做键名 slug 化、类型推断、缺省审批策略与导出兜底，
 * 不改变计划语义；修复后仍交给 validatePlan 做硬校验，非法照样回退。
 */
function asArr(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeCandidate(raw) {
  const src = raw?.plan && Array.isArray(raw.plan.nodes) ? raw.plan : raw;
  if (!src || !Array.isArray(src.nodes)) return raw;
  const used = new Set();
  const map = new Map();
  const slug = (value, index) => {
    const base = String(value || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    let key = base || `node-${index + 1}`;
    let n = 2;
    while (used.has(key)) key = `${base || `node-${index + 1}`}-${n++}`;
    used.add(key);
    return key;
  };
  const nodes = src.nodes.slice(0, 24).map((node, index) => {
    const rawKey = node.node_key ?? node.key ?? node.id ?? node.name;
    const key = slug(rawKey, index);
    map.set(String(rawKey ?? key), key);
    const agent = String(node.agent_key ?? node.agent ?? '').trim();
    const type = NODE_TYPES.includes(node.node_type)
      ? node.node_type
      : agent === 'doc' ? 'export' : agent === 'quality' ? 'quality' : agent === 'supervisor' ? 'human-review' : 'agent';
    return {
      ...node,
      node_key: key,
      agent_key: agent,
      node_type: type,
      depends_on: asArr(node.depends_on).map(String),
    };
  });
  for (const node of nodes) {
    node.depends_on = node.depends_on
      .map((dep) => map.get(dep) ?? dep)
      .filter((dep) => used.has(dep) && dep !== node.node_key);
    if (node.node_type === 'human-review' && !node.review_policy_key) node.review_policy_key = 'default';
  }
  if (!nodes.some((node) => node.node_type === 'export')) {
    const consumed = new Set(nodes.flatMap((node) => node.depends_on));
    const sinks = nodes.filter((node) => !consumed.has(node.node_key) && node.node_type !== 'export').slice(-2);
    nodes.push({ node_key: 'export', agent_key: 'doc', node_type: 'export', depends_on: sinks.map((node) => node.node_key) });
  }
  return { ...src, nodes };
}

/** 首次规划：有真实模型时尝试 LLM，否则用兜底 DAG（两者都要过同一套校验） */
export async function planRun({ run, project, analysisHint }) {
  const fallback = structuredClone(FALLBACK_PLAN);
  fallback.objective = run.objective;
  fallback.rationale = `基于项目「${project.name}」的确定性计划：解析 → 检索 → 格式提取 → 编制计划 → 要求确认 → 四类审查 → 法规 → 技术/商务 → 一致性 → 质检 → 预览 → 终审 → 汇总 → 导出。`;

  // 默认不让模型改流程：模型给的 DAG 常绕开「格式提取/编制计划/预览/终审」，
  // 导致闸门看到的是解析 JSON 而不是编制计划。只有显式开启 workflow.llm_plan 才允许自定义。
  const workflowCfg = loadSettings().workflow || {};
  if (workflowCfg.llm_plan !== true) {
    const plan = validatePlan(fallback);
    plan.source = 'fallback';
    return { plan, source: 'fallback', reason: '使用内置十步流程（未开启模型自定义编排）' };
  }

  const llmPlan = await generateJson({
    system: [
      '你是投标标书工作流的总控规划器，只输出 JSON，不写任何标书正文。',
      '输出结构：{"plan_version":1,"objective":"...","nodes":[{"node_key":"kebab-case","agent_key":"...","node_type":"agent|quality|human-review|export","depends_on":["..."],"review_policy_key":"single|default|parallel"}],"budget":{"max_agent_calls":40},"rationale":"..."}。',
      'node_key 必须是纯小写字母/数字/连字符（如 parse、review-strategy），不要中文。',
      'agent_key 只能取 parse-tender,bid-strategy,knowledge,tech,commercial,compliance,quality,doc。',
      '必须包含且仅包含一个 node_type=export 的终结点（agent_key=doc）。',
      '人工门禁节点 node_type=human-review，必须给 review_policy_key（single=单级，default=三级，parallel=并签）。',
      '节点总数 ≤ 12；能并行的节点（如 tech 与 commercial）不要互相依赖。rationale ≤ 200 字，说明为什么这样编排。',
    ].join('\n'),
    user: JSON.stringify({
      objective: run.objective,
      project: { name: project.name, bidder: project.bidder_name, budget: project.budget, deadline: project.deadline },
      hint: analysisHint || null,
    }),
    mock: () => fallback,
  });

  const status = llmStatus();
  const llmUsable = status.mode === 'openai' && status.ready;
  // 模型自定义编排也必须保留关键节点，否则退回内置流程
  const REQUIRED = ['parse-tender', 'format-extract', 'doc-plan', 'requirements-confirm', 'final-approval', 'export'];
  try {
    const candidate = normalizeCandidate(llmPlan);
    const keys = new Set((candidate.nodes || []).map((node) => node.node_key));
    const missing = REQUIRED.filter((key) => !keys.has(key));
    if (missing.length) throw new PlanInvalid(`模型计划缺少关键节点：${missing.join('、')}`);
    const plan = validatePlan(candidate);
    // mock 模式下 generateJson 原样返回兜底对象：不能标成 LLM 规划
    const usedLlm = llmUsable && llmPlan !== fallback;
    plan.source = usedLlm ? 'llm' : 'fallback';
    return usedLlm
      ? { plan, source: 'llm' }
      : { plan, source: 'fallback', reason: 'LLM 未启用或返回兜底计划（mock 模式）' };
  } catch (error) {
    const plan = validatePlan(fallback);
    plan.source = 'fallback';
    return { plan, source: 'fallback', reason: `模型计划不可用，已回退内置流程：${String(error.message)}` };
  }
}

/** 返工规则表（确定性，不进模型） */
export function reworkTargets(findings) {
  const targets = new Set();
  const reasons = [];
  for (const f of findings || []) {
    if (f.skipped || f.score === null) continue;
    if (f.severity !== 'blocking' && f.severity !== 'veto') continue;
    if (f.rule === 'MAT-01' || f.rule === 'MAT-02') { targets.add('knowledge'); targets.add('commercial'); reasons.push('资质/证书匹配不足'); }
    if (f.rule === 'REQ-02' || f.rule === 'TEC-01' || f.rule === 'TEC-02' || f.rule === 'TEC-03') { targets.add('tech'); reasons.push('技术方案覆盖/质量不足'); }
    if (f.rule === 'ACC-01' || f.rule === 'ACC-02' || f.rule === 'ACC-03' || f.rule === 'DOC-03') { targets.add('tech'); reasons.push('内容准确性/篇幅问题'); }
    if (f.rule === 'REQ-03') { targets.add('tech'); reasons.push('量化指标缺失'); }
    if (f.rule === 'VETO') { targets.add('compliance'); reasons.push('废标条款未响应'); }
    if (f.rule === 'DOC-01' || f.rule === 'DOC-02' || f.rule === 'DOC-04') { targets.add('doc'); reasons.push('文档规范性问题'); }
  }
  if (targets.has('knowledge')) targets.add('tech');
  return { targets: [...targets], reasons: [...new Set(reasons)] };
}

/** 重规划：只改节点状态与依赖，不重排已成功节点；plan_version + 1 */
export function replan({ run, plan, findings }) {
  const next = structuredClone(plan);
  next.plan_version = Number(plan.plan_version || 1) + 1;
  const { targets, reasons } = reworkTargets(findings);
  const hasKnowledge = next.nodes.some((n) => n.agent_key === 'knowledge');
  if (targets.includes('knowledge') && !hasKnowledge) {
    next.nodes.push({ node_key: 'knowledge', agent_key: 'knowledge', node_type: 'agent', depends_on: ['parse-tender'] });
    for (const n of next.nodes) {
      if (n.agent_key === 'commercial' && !n.depends_on.includes('knowledge')) n.depends_on.push('knowledge');
    }
  }
  next.rationale = `质量返工：${reasons.join('；') || '缺陷修复'}；目标 Agent：${targets.join('、') || '-'}（${clip(findings?.[0]?.message || '', 60)}）`;
  next.planned_targets = targets;
  return { plan: validatePlan(next), targets, reasons };
}

/**
 * 计划的结构化并行组：按依赖深度分层，只返回「同层 ≥2 个节点」的层。
 * 用途：supervisor.plan_created 事件里说明"计划打算怎么并行"（真实调度批次看 nodes.parallel 事件）。
 */
export function planParallelGroups(plan) {
  const nodes = plan?.nodes || [];
  if (!nodes.length) return [];
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const depth = new Map();
  const depthOf = (key, stack = new Set()) => {
    if (depth.has(key)) return depth.get(key);
    if (stack.has(key)) return 0;
    stack.add(key);
    const node = byKey.get(key);
    const deps = Array.isArray(node?.depends_on) ? node.depends_on : [];
    const value = deps.length ? 1 + Math.max(...deps.map((d) => depthOf(d, stack))) : 0;
    stack.delete(key);
    depth.set(key, value);
    return value;
  };
  for (const node of nodes) depthOf(node.node_key);
  const layers = new Map();
  for (const node of nodes) {
    const d = depth.get(node.node_key) ?? 0;
    if (!layers.has(d)) layers.set(d, []);
    layers.get(d).push(node.node_key);
  }
  return [...layers.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, keys]) => keys)
    .filter((keys) => keys.length > 1);
}

/** 计划摘要（事件/接口都用同一份，避免口径漂移） */
export function planDigest(plan) {
  const nodes = plan?.nodes || [];
  return {
    plan_version: Number(plan?.plan_version || 1),
    node_count: nodes.length,
    node_keys: nodes.map((n) => n.node_key),
    agent_keys: [...new Set(nodes.map((n) => n.agent_key))],
    parallel_groups: planParallelGroups(plan),
    source: plan?.source ?? null,
    rationale: clip(plan?.rationale || '', 300),
  };
}

