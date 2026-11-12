// 工作流引擎：DAG 调度 / 租约 / 产物版本 / 失效传播 / 质量门禁 / 人工门禁 / 恢复。
// 设计原则：确定性外壳。LLM 只出现在 planner 与评分 rubric 里，执行/重试/失效全部是代码。
import { all, get, run, tx, jparse, jstr } from '../db.mjs';
import { id, nowIso, sha256, clip } from '../lib/util.mjs';
import { publish } from '../lib/bus.mjs';
import { planRun, replan as replanPlan, reworkTargets, planDigest } from './planner.mjs';
import { AGENT_HANDLERS } from './agents.mjs';
import { evaluateQuality, normalizeQualityConfig } from './quality.mjs';
import { openGate } from './review.mjs';
import { loadSettings } from '../seed.mjs';

const TERMINAL_RUN = new Set(['completed', 'failed', 'cancelled']);
const BLOCKING_NODE = new Set(['pending', 'ready', 'running', 'waiting_human', 'interrupted', 'invalidated']);
const SKIPPABLE = new Set(['pending', 'ready', 'failed', 'waiting_human', 'invalidated']);
const SUPERVISOR_EVENT_PREFIXES = ['supervisor.', 'plan.'];
const SUPERVISOR_EVENT_TYPES = new Set(['nodes.parallel', 'node.invalidated']);
const PAYLOAD_LIMIT_BYTES = 4096;

/**
 * 事件 payload 裁剪：events 表是"决策流水"，不是产物仓库。
 * ≤4KB 原样落库；超长时截断字符串/数组，再不行只留摘要 + 摘要哈希（可回查 artifacts）。
 */
export function boundPayload(payload, maxBytes = PAYLOAD_LIMIT_BYTES) {
  const source = payload && typeof payload === 'object' ? payload : { value: payload };
  const full = JSON.stringify(source);
  if (Buffer.byteLength(full) <= maxBytes) return source;
  const trimmed = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') trimmed[key] = clip(value, 240);
    else if (Array.isArray(value)) trimmed[key] = value.slice(0, 12).map((v) => (typeof v === 'string' ? clip(v, 80) : v));
    else if (value && typeof value === 'object') trimmed[key] = clip(JSON.stringify(value), 240);
    else trimmed[key] = value;
  }
  trimmed.truncated = true;
  if (Buffer.byteLength(JSON.stringify(trimmed)) <= maxBytes) return trimmed;
  return {
    truncated: true,
    payload_bytes: Buffer.byteLength(full),
    payload_digest: sha256(source).slice(0, 16),
    rationale: clip(String(source.rationale ?? source.reason ?? ''), 160),
  };
}

/** 事件分类 → Supervisor 决策视图（runs/:id/supervisor 与前端事件流共用同一份口径） */
function isSupervisorDecisionEvent(type) {
  return SUPERVISOR_EVENT_PREFIXES.some((p) => String(type).startsWith(p)) || SUPERVISOR_EVENT_TYPES.has(type);
}

export class Engine {
  constructor() {
    this.busy = new Set();
    this.timer = null;
  }

  // ---------- 基础 ----------
  nextSeq(runId) {
    const row = get('SELECT MAX(seq) AS m FROM events WHERE run_id = ?', runId);
    return Number(row?.m ?? 0) + 1;
  }

  emit(runId, type, payload = {}, actor = { type: 'system', id: null }) {
    const runRow = get('SELECT project_id FROM runs WHERE id = ?', runId);
    run('INSERT INTO events (run_id, seq, type, actor_type, actor_id, payload_json, created_at) VALUES (?,?,?,?,?,?,?)',
      runId, this.nextSeq(runId), type, actor.type, actor.id, jstr(payload), nowIso());
    if (runRow) publish(runRow.project_id, 'workflow', { type, run_id: runId, ...payload });
  }

  /** Supervisor 事件：统一走 4KB 裁剪，避免把整份计划/产物塞进 events */
  emitSupervisor(runId, type, payload = {}, actor = { type: 'system', id: null }) {
    const bounded = boundPayload(payload);
    this.emit(runId, type, bounded, actor);
    return bounded;
  }

  project(runId) {
    const runRow = get('SELECT * FROM runs WHERE id = ?', runId);
    return runRow ? get('SELECT * FROM projects WHERE id = ?', runRow.project_id) : null;
  }

  artifacts(runId) {
    const rows = all('SELECT * FROM artifacts WHERE run_id = ? ORDER BY kind, version DESC', runId);
    const out = {};
    for (const row of rows) {
      if (out[row.kind]) continue; // 只取最新版本
      out[row.kind] = jparse(row.payload_json, null);
    }
    return out;
  }

  // ---------- 创建 / 规划 ----------
  async createRun({ projectId, user, objective, mode = 'auto', dryRun = false }) {
    const project = get('SELECT * FROM projects WHERE id = ?', projectId);
    if (!project) throw new Error('项目不存在');
    const runId = id('run');
    const settings = loadSettings();
    const budget = { max_tokens: 3000000, max_wall_ms: 14400000, max_agent_calls: 40 };
    tx(() => {
      run(`INSERT INTO runs (id, project_id, def_key, def_version, status, objective, plan_json, plan_version, context_json,
            budget_json, parallelism, dry_run, mode, created_by, started_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        runId, projectId, 'default', 1, 'planning', objective || `为「${project.name}」生成投标文件`,
        null, 0,
        jstr({ objective, artifacts: {}, reviews: {}, quality: {}, budget: { tokens_used: 0, agent_calls: 0, wall_ms: 0 }, flags: { veto_pending: false, force_human: false, degraded: false } }),
        jstr(budget), settings.workflow?.parallelism ?? 2, dryRun ? 1 : 0, mode, user.id, nowIso(), nowIso());
    });
    this.emit(runId, 'run.created', { project_id: projectId, objective, mode, dry_run: dryRun }, { type: 'user', id: user.id });
    await this.planAndStart(runId);
    return get('SELECT * FROM runs WHERE id = ?', runId);
  }

  async planAndStart(runId) {
    const runRow = get('SELECT * FROM runs WHERE id = ?', runId);
    const project = get('SELECT * FROM projects WHERE id = ?', runRow.project_id);
    const { plan, source, reason } = await planRun({ run: runRow, project });
    this.applyPlan(runId, plan);
    this.emit(runId, 'plan.created', { plan_version: plan.plan_version, node_count: plan.nodes.length, source, reason: reason ?? null, rationale: plan.rationale });
    if (source !== 'llm') this.emit(runId, 'plan.fallback', { reason: reason ?? 'mock-provider' });
    const digest = planDigest(plan);
    this.emitSupervisor(runId, 'supervisor.plan_created', {
      plan_version: digest.plan_version,
      node_count: digest.node_count,
      node_keys: digest.node_keys,
      parallel_groups: digest.parallel_groups.slice(0, 6),
      agent_keys: digest.agent_keys,
      source: digest.source,
      rationale: digest.rationale,
    });
    this.tick(runId);
  }

  applyPlan(runId, plan) {
    tx(() => {
      const existing = new Map(all('SELECT * FROM node_runs WHERE run_id = ?', runId).map((n) => [n.node_key, n]));
      for (const node of plan.nodes) {
        const prev = existing.get(node.node_key);
        if (prev) {
          run('UPDATE node_runs SET agent_key=?, node_type=?, depends_on=?, input_json=?, updated_at=? WHERE id=?',
            node.agent_key, node.node_type, jstr(node.depends_on), jstr(node.input_refs ?? { params: node.params ?? {} }), nowIso(), prev.id);
        } else {
          run(`INSERT INTO node_runs (id, run_id, node_key, agent_key, node_type, status, attempt, iteration, depends_on, input_json,
                dedupe_key, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            id('nod'), runId, node.node_key, node.agent_key, node.node_type,
            node.depends_on.length === 0 ? 'ready' : 'pending', 0, 0,
            jstr(node.depends_on), jstr(node.input_refs ?? { params: node.params ?? {} }),
            `${runId}:${node.node_key}:0`, nowIso());
        }
      }
      // 计划中已删除的未执行节点直接移除
      const planKeys = new Set(plan.nodes.map((n) => n.node_key));
      for (const [key, row] of existing) {
        if (!planKeys.has(key) && ['pending', 'ready'].includes(row.status)) run('DELETE FROM node_runs WHERE id = ?', row.id);
      }
      run("UPDATE runs SET plan_json=?, plan_version=?, status='running', budget_json=?, updated_at=? WHERE id=?",
        jstr(plan), plan.plan_version, jstr(plan.budget), nowIso(), runId);
    });
  }

  // ---------- 调度 ----------
  tick(runId) {
    if (this.busy.has(runId)) return;
    this.busy.add(runId);
    try {
      const runRow = get('SELECT * FROM runs WHERE id = ?', runId);
      if (!runRow || TERMINAL_RUN.has(runRow.status) || runRow.status === 'paused') { return; }
      this.promoteReady(runId);

      // 预算闸门
      const ctx = jparse(runRow.context_json, {});
      const budget = jparse(runRow.budget_json, {});
      if ((budget.max_tokens && ctx.budget.tokens_used > budget.max_tokens) || (budget.max_agent_calls && ctx.budget.agent_calls > budget.max_agent_calls)) {
        run("UPDATE runs SET status='paused', updated_at=? WHERE id=?", nowIso(), runId);
        this.emit(runId, 'budget.exceeded', { tokens_used: ctx.budget.tokens_used, agent_calls: ctx.budget.agent_calls });
        return;
      }
      // 85% 预警：只发一次（flags.budget_warning 去重），并作为"跳过第二评委"的信号
      this.checkBudgetWarning(runId, runRow, ctx, budget);

      const running = get("SELECT COUNT(*) AS c FROM node_runs WHERE run_id=? AND status='running'", runId)?.c ?? 0;
      const slots = Math.max(0, Number(runRow.parallelism || 2) - running);
      if (slots === 0) return;

      const ready = all("SELECT * FROM node_runs WHERE run_id=? AND status='ready' ORDER BY rowid ASC", runId);
      if (!ready.length) { this.finishIfDone(runId); return; }

      const batch = [];
      for (const node of ready) {
        if (batch.length >= slots) break;
        if (batch.length === 0) { batch.push(node); continue; }
        if (batch.some((b) => !this.canParallel(b, node))) continue;
        batch.push(node);
      }
      for (const node of batch) {
        const claimed = this.claim(node.id);
        if (!claimed) continue;
        void this.executeNode(runId, node.node_key).catch((error) => {
          this.failNode(runId, node.node_key, error).catch(() => undefined);
        });
      }
      if (batch.length > 1) {
        this.emit(runId, 'nodes.parallel', { nodes: batch.map((n) => n.node_key), slots });
      }
    } finally {
      this.busy.delete(runId);
    }
  }

  /**
   * 预算预警：used.tokens > 0.85 * max 时发 supervisor.budget_warning（每个 run 只发一次）。
   * 同时把 flags.budget_warning 置位，质量节点据此跳过第二次评委（省 token 先保结果）。
   */
  checkBudgetWarning(runId, runRow, ctx, budget) {
    const maxTokens = Number(budget?.max_tokens || 0);
    if (!maxTokens) return false;
    const used = Number(ctx?.budget?.tokens_used || 0);
    const ratio = used / maxTokens;
    if (ratio <= 0.85) return false;
    if (ctx?.flags?.budget_warning) return true;
    this.updateContext(runId, (c) => {
      c.flags.budget_warning = true;
      c.flags.budget_warning_ratio = Number(ratio.toFixed(4));
      c.flags.budget_warning_at = nowIso();
    });
    this.emitSupervisor(runId, 'supervisor.budget_warning', {
      used_tokens: used,
      max_tokens: maxTokens,
      threshold: 0.85,
      ratio: Number(ratio.toFixed(3)),
      action: 'skip_second_judge',
    });
    return true;
  }

  /** 并行边界：依赖 AgentService 的（tech/compliance/doc）串行，其余可并行 */
  canParallel(a, b) {
    const serial = new Set(['tech', 'compliance', 'doc']);
    if (serial.has(a.agent_key) || serial.has(b.agent_key)) return false;
    if (a.node_type === 'human-review' || b.node_type === 'human-review') return false;
    if (a.node_type === 'export' || b.node_type === 'export') return false;
    return a.agent_key !== b.agent_key;
  }

  claim(nodeId) {
    const lease = new Date(Date.now() + 45000).toISOString();
    const res = run("UPDATE node_runs SET status='running', lease_owner=?, lease_expires_at=?, started_at=COALESCE(started_at, ?), updated_at=? WHERE id=? AND status='ready'",
      `pid-${process.pid}`, lease, nowIso(), nowIso(), nodeId);
    return res.changes > 0;
  }

  promoteReady(runId) {
    const nodes = all('SELECT * FROM node_runs WHERE run_id = ?', runId);
    const done = new Set(nodes.filter((n) => ['succeeded', 'skipped'].includes(n.status)).map((n) => n.node_key));
    let count = 0;
    for (const node of nodes) {
      if (!['pending', 'invalidated'].includes(node.status)) continue;
      const deps = jparse(node.depends_on, []);
      if (!deps.every((d) => done.has(d))) continue;
      run("UPDATE node_runs SET status='ready', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?", nowIso(), node.id);
      count += 1;
    }
    return count;
  }

  /** gate 的"审核对象"：优先取最近祖先节点的产物（review-1 → quality:quality-1），回退到最新产物 */
  gateArtifact(runId, gateKey) {
    const nodes = all('SELECT * FROM node_runs WHERE run_id = ?', runId);
    const byKey = new Map(nodes.map((n) => [n.node_key, n]));
    const queue = [...jparse(byKey.get(gateKey)?.depends_on, [])];
    const seen = new Set();
    while (queue.length) {
      const key = queue.shift();
      if (seen.has(key)) continue;
      seen.add(key);
      const node = byKey.get(key);
      if (node?.artifact_kind) {
        const artifact = get('SELECT * FROM artifacts WHERE run_id=? AND kind=? ORDER BY version DESC LIMIT 1', runId, node.artifact_kind);
        if (artifact) return artifact;
      }
      queue.push(...jparse(node?.depends_on, []));
    }
    return get('SELECT * FROM artifacts WHERE run_id=? ORDER BY created_at DESC LIMIT 1', runId);
  }

  // ---------- 执行 ----------
  async executeNode(runId, nodeKey) {
    const node = get('SELECT * FROM node_runs WHERE run_id=? AND node_key=?', runId, nodeKey);
    const runRow = get('SELECT * FROM runs WHERE id = ?', runId);
    const plan = jparse(runRow.plan_json, { nodes: [] });
    const spec = (plan.nodes || []).find((n) => n.node_key === nodeKey) || {};
    const project = this.project(runId);
    const artifacts = this.artifacts(runId);
    const feedback = jparse(node.output_json, {})?.review_feedback ?? null;
    const params = { ...(spec.params || {}), ...(jparse(node.input_json, {})?.params || {}) };

    try {
      if (node.node_type === 'human-review') {
        const gateRef = this.gateArtifact(runId, nodeKey);
        const opened = openGate({
          run: runRow, node, gateKey: nodeKey, policyKey: spec.review_policy_key || 'single', priority: 0,
          artifactKind: gateRef?.kind ?? null, artifactVersion: gateRef?.version ?? null,
        });
        run("UPDATE node_runs SET status='waiting_human', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?", nowIso(), node.id);
        run("UPDATE runs SET status='waiting_human', updated_at=? WHERE id=?", nowIso(), runId);
        this.emit(runId, 'gate.opened', { node_key: nodeKey, review_task_id: opened.reviewTaskId, level: 1, level_total: opened.levelTotal });
        return;
      }

      this.emit(runId, 'node.started', { node_key: nodeKey, agent_key: node.agent_key, attempt: node.attempt, iteration: node.iteration });

      if (node.node_type === 'quality') {
        await this.runQualityNode({ runId, node, runRow, project, artifacts, params });
        return;
      }

      const handler = AGENT_HANDLERS[spec.agent_key] || AGENT_HANDLERS[node.agent_key];
      if (!handler) throw new Error(`未注册的 Agent：${spec.agent_key || node.agent_key}`);

      // 演示/演示故障注入：模拟 Agent 耗时，便于观察并行与崩溃恢复
      const delayMs = Number(process.env.BIDCORE_AGENT_DELAY_MS || 0);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

      if (runRow.dry_run) {
        const drafts = [{ kind: `${nodeKey}.dryrun`, summary: `dry-run：${node.agent_key} 跳过真实执行`, payload: { skipped: true } }];
        this.succeedNode(runId, node, drafts, { tokens: 0, agent_calls: 0 }, ['dry-run 模式：仅校验编排']);
        return;
      }

      const started = Date.now();
      const result = await handler({ run: runRow, project, node, params, artifacts, feedback, iteration: node.iteration });
      const drafts = (result.artifacts || []).map((a) => ({ ...a, provenance: { ...(a.provenance || {}), agent: node.agent_key, iteration: node.iteration, attempt: node.attempt } }));
      const metrics = { ...(result.metrics || {}), wall_ms: Date.now() - started };
      this.succeedNode(runId, node, drafts, metrics, result.log || []);
      for (const line of result.log || []) this.emit(runId, 'node.log', { node_key: nodeKey, message: line });
    } catch (error) {
      await this.failNode(runId, nodeKey, error);
    }
  }

  async runQualityNode({ runId, node, runRow, project, artifacts, params }) {
    const settings = loadSettings();
    const qualityConfig = normalizeQualityConfig(settings.quality);
    const iteration = node.iteration + 1;
    // 预算闸门（第二道）：超过 85% 就只跑一次评委，judge 元数据里标注跳过原因
    const ctxNow = jparse(runRow.context_json, {});
    const budgetNow = jparse(runRow.budget_json, {});
    const usedTokens = Number(ctxNow.budget?.tokens_used || 0);
    const maxTokens = Number(budgetNow.max_tokens || 0);
    const budgetRatio = maxTokens ? usedTokens / maxTokens : 0;
    const budgetLimited = budgetRatio > 0.85;
    this.checkBudgetWarning(runId, runRow, ctxNow, budgetNow);
    const evaluation = await evaluateQuality({
      project, artifacts, config: qualityConfig, iteration, nodeKey: node.node_key,
      judge: { two_pass: !budgetLimited, skip_reason: budgetLimited ? 'budget_gt_85pct' : undefined },
    });
    const artifactDraft = {
      kind: `quality:${node.node_key}`,
      summary: `质量评估 ${evaluation.total} 分（${evaluation.verdict}）：${evaluation.summary.top_issues.join('；') || '无阻塞项'}`,
      payload: evaluation,
      provenance: { agent: 'quality', rule_engine: 'deterministic', judge: 'rubric-capped' },
    };
    const versions = this.writeArtifacts(runId, node, [artifactDraft]);
    run('INSERT INTO quality_reports (id, run_id, node_run_id, node_key, iteration, total_score, dimension_json, verdict, findings_json, judge_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id('qr'), runId, node.id, node.node_key, iteration, evaluation.total, jstr(evaluation.dimensions), evaluation.verdict,
      jstr(evaluation.findings), jstr(evaluation.judge), nowIso());
    run("UPDATE node_runs SET quality_score=?, iteration=?, artifact_kind=?, artifact_version=?, updated_at=? WHERE id=?",
      evaluation.total, iteration, artifactDraft.kind, versions[0]?.version ?? 1, nowIso(), node.id);
    this.updateContext(runId, (ctx) => {
      ctx.quality[node.node_key] = { total: evaluation.total, verdict: evaluation.verdict, iteration: node.iteration };
      if (evaluation.verdict === 'veto') ctx.flags.veto_pending = true;
    });
    publish(runRow.project_id, 'quality', { type: 'quality.evaluated', run_id: runId, node_key: node.node_key, total: evaluation.total, verdict: evaluation.verdict });
    this.emit(runId, 'quality.evaluated', { node_key: node.node_key, total: evaluation.total, verdict: evaluation.verdict, dimensions: evaluation.dimensions, findings: evaluation.findings.length });

    if (evaluation.verdict === 'pass') {
      this.finishNode(runId, node, { tokens: 0, agent_calls: 0 }, [`质量评估通过：${evaluation.total} 分`]);
      return;
    }

    const maxIterations = Number(qualityConfig.max_iterations ?? 3);
    const forceHuman = evaluation.verdict === 'veto' || iteration >= maxIterations;

    if (forceHuman) {
      // 熔断或 veto：不自动烧钱，直接转人工
      const opened = openGate({
        run: runRow, node, gateKey: node.node_key, policyKey: 'single',
        priority: evaluation.verdict === 'veto' ? 1 : 0,
        artifactKind: artifactDraft.kind, artifactVersion: versions[0]?.version ?? 1,
      });
      run("UPDATE node_runs SET status='waiting_human', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?", nowIso(), node.id);
      run("UPDATE runs SET status='waiting_human', updated_at=? WHERE id=?", nowIso(), runId);
      this.emit(runId, 'gate.opened', {
        node_key: node.node_key, review_task_id: opened.reviewTaskId, level: 1,
        reason: evaluation.verdict === 'veto' ? '存在未响应的废标条款' : `质量未达标且已达迭代上限（${maxIterations}）`,
      });
      return;
    }

    // 自动返工：目标节点重跑 → 自身失效 → 重新评估
    const { targets } = reworkTargets(evaluation.findings);
    const nodes = all('SELECT * FROM node_runs WHERE run_id = ?', runId);
    const targetKeys = [...new Set(nodes.filter((n) => targets.includes(n.agent_key) && n.node_key !== node.node_key).map((n) => n.node_key))];
    if (!targetKeys.length) targetKeys.push(...nodes.filter((n) => n.agent_key === 'tech').map((n) => n.node_key));
    for (const key of targetKeys) {
      const target = nodes.find((n) => n.node_key === key);
      if (!target) continue;
      const depsDone = jparse(target.depends_on, []).every((d) => nodes.find((x) => x.node_key === d)?.status === 'succeeded');
      run(`UPDATE node_runs SET status=?, attempt=attempt+1, iteration=iteration+1, lease_owner=NULL, lease_expires_at=NULL,
            output_json=?, updated_at=? WHERE id=?`,
        depsDone ? 'ready' : 'pending',
        jstr({ review_feedback: { action: 'quality-revise', comment: `质量返工：${evaluation.summary.top_issues.join('；')}`, edits: [], targets } }),
        nowIso(), target.id);
    }
    this.invalidateDownstream(runId, targetKeys, node.node_key);
    // 关键：评估节点自身回到 invalidated（清租约），等目标重跑成功后由 promoteReady 推回 ready 再次评估
    run("UPDATE node_runs SET status='invalidated', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?", nowIso(), node.id);
    this.planRevise(runId, evaluation.findings, targetKeys);
    // Supervisor 返工决策（缺陷码 + 目标 Agent + 原因），供运行详情/事件流/决策视图消费
    const defects = [...new Set(evaluation.findings
      .filter((f) => ['blocking', 'veto'].includes(f.severity))
      .map((f) => f.rule))];
    this.emitSupervisor(runId, 'supervisor.rework', {
      trigger: 'quality',
      iteration,
      total: evaluation.total,
      verdict: evaluation.verdict,
      defect_codes: defects.slice(0, 12),
      target_agents: [...new Set(targets)].slice(0, 8),
      node_keys: targetKeys.slice(0, 12),
      reason: clip(evaluation.summary.top_issues.join('；') || '质量未达标', 200),
      budget_limited: budgetLimited,
    });
    run("UPDATE runs SET status='running', updated_at=? WHERE id=?", nowIso(), runId);
    this.emit(runId, 'quality.revise', {
      node_key: node.node_key, total: evaluation.total, verdict: evaluation.verdict,
      iteration: node.iteration + 1, targets: targetKeys, issues: evaluation.summary.top_issues,
    });
    setTimeout(() => this.tick(runId), 30);
  }

  planRevise(runId, findings, targetKeys) {
    const runRow = get('SELECT * FROM runs WHERE id = ?', runId);
    const plan = jparse(runRow.plan_json, { nodes: [] });
    try {
      const { plan: next, reasons } = replanPlan({ run: runRow, plan, findings });
      // 合并：新计划只更新 rationale/version 与知识节点，节点集合保持不变（返工节点已在上面置 ready）
      const merged = {
        ...plan,
        plan_version: next.plan_version,
        rationale: next.rationale,
        nodes: plan.nodes.some((n) => n.agent_key === 'knowledge')
          ? plan.nodes
          : next.nodes,
      };
      run('UPDATE runs SET plan_json=?, plan_version=?, updated_at=? WHERE id=?', jstr(merged), merged.plan_version, nowIso(), runId);
      this.emit(runId, 'plan.revised', { plan_version: merged.plan_version, targets: targetKeys, reasons });
      this.emitSupervisor(runId, 'supervisor.replan', {
        plan_version: merged.plan_version,
        node_count: merged.nodes.length,
        targets: targetKeys.slice(0, 12),
        reasons: (reasons || []).slice(0, 6),
        rationale: clip(merged.rationale || '', 240),
        parallel_groups: planDigest(merged).parallel_groups.slice(0, 6),
      });
    } catch (error) {
      this.emit(runId, 'plan.revise_failed', { reason: String(error.message) });
    }
  }

  // ---------- 产物 / 节点状态 ----------
  writeArtifacts(runId, node, drafts) {
    // 人工意见/结构化 edits 一律落到产物 provenance.human_edits（可追溯"这版是谁改的、改了什么"）
    const feedback = jparse(node?.output_json, {})?.review_feedback ?? null;
    const humanEdits = Array.isArray(feedback?.edits) ? feedback.edits : [];
    const humanFeedback = feedback
      ? {
        action: feedback.action ?? null,
        comment: clip(feedback.comment ?? '', 200),
        targets: Array.isArray(feedback.targets) ? feedback.targets : [],
        at: nowIso(),
      }
      : null;
    const written = [];
    for (const draft of drafts) {
      const last = get('SELECT MAX(version) AS v FROM artifacts WHERE run_id=? AND kind=?', runId, draft.kind);
      const version = Number(last?.v ?? 0) + 1;
      const digest = sha256(draft.payload ?? draft.summary);
      const provenance = { ...(draft.provenance || {}) };
      if (humanEdits.length) provenance.human_edits = humanEdits;
      if (humanFeedback && (humanEdits.length || humanFeedback.action)) provenance.human_feedback = humanFeedback;
      run(`INSERT INTO artifacts (id, run_id, node_run_id, kind, version, status, sha256, summary, payload_json, storage_path, provenance_json, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        id('art'), runId, node.id, draft.kind, version, 'active', digest, clip(draft.summary, 900),
        jstr(draft.payload ?? null), draft.storagePath ?? null, jstr(provenance), nowIso());
      written.push({ kind: draft.kind, version, sha256: digest });
      this.updateContext(runId, (ctx) => {
        ctx.artifacts[draft.kind] = { kind: draft.kind, version, summary: clip(draft.summary, 200), sha256: digest };
      });
    }
    return written;
  }

  succeedNode(runId, node, drafts, metrics = {}, log = []) {
    const written = this.writeArtifacts(runId, node, drafts);
    const first = written[0];
    run("UPDATE node_runs SET status='succeeded', finished_at=?, lease_owner=NULL, lease_expires_at=NULL, error_code=NULL, error_message=NULL, artifact_kind=?, artifact_version=?, updated_at=? WHERE id=?",
      nowIso(), first?.kind ?? null, first?.version ?? null, nowIso(), node.id);
    this.updateContext(runId, (ctx) => {
      ctx.budget.tokens_used += Number(metrics.tokens || 0);
      ctx.budget.agent_calls += Number(metrics.agent_calls || 0);
      ctx.budget.wall_ms += Number(metrics.wall_ms || 0);
    });
    this.emit(runId, 'node.succeeded', { node_key: node.node_key, artifacts: written, log });
    this.promoteReady(runId);
    setTimeout(() => this.tick(runId), 10);
  }

  finishNode(runId, node, metrics = {}, log = []) {
    run("UPDATE node_runs SET status='succeeded', finished_at=?, lease_owner=NULL, lease_expires_at=NULL, error_code=NULL, error_message=NULL, updated_at=? WHERE id=?",
      nowIso(), nowIso(), node.id);
    this.updateContext(runId, (ctx) => {
      ctx.budget.tokens_used += Number(metrics.tokens || 0);
      ctx.budget.agent_calls += Number(metrics.agent_calls || 0);
    });
    this.emit(runId, 'node.succeeded', { node_key: node.node_key, log });
    this.promoteReady(runId);
    setTimeout(() => this.tick(runId), 10);
  }

  async failNode(runId, nodeKey, error) {
    const node = get('SELECT * FROM node_runs WHERE run_id=? AND node_key=?', runId, nodeKey);
    if (!node) return;
    const plan = jparse(get('SELECT plan_json FROM runs WHERE id=?', runId)?.plan_json, { nodes: [] });
    const spec = (plan.nodes || []).find((n) => n.node_key === nodeKey) || {};
    const maxAttempts = Number(spec.retry?.max_attempts ?? 1);
    const message = String(error?.message || error);
    const isBusy = /busy/i.test(message);

    if (isBusy || node.attempt < maxAttempts) {
      run("UPDATE node_runs SET status='ready', attempt=attempt+?, lease_owner=NULL, lease_expires_at=NULL, error_message=?, updated_at=? WHERE id=?",
        isBusy ? 0 : 1, clip(message, 400), nowIso(), node.id);
      this.emit(runId, 'node.retry', { node_key: nodeKey, reason: isBusy ? 'agent_busy' : message, attempt: node.attempt });
      setTimeout(() => this.tick(runId), isBusy ? 8000 : 1500);
      return;
    }

    run("UPDATE node_runs SET status='failed', finished_at=?, lease_owner=NULL, lease_expires_at=NULL, error_code='WF_NODE_FAILED', error_message=?, updated_at=? WHERE id=?",
      nowIso(), clip(message, 800), nowIso(), node.id);
    run("UPDATE runs SET status='failed', error_code='WF_NODE_FAILED', error_message=?, updated_at=? WHERE id=?", clip(`${nodeKey}: ${message}`, 800), nowIso(), runId);
    this.emit(runId, 'node.failed', { node_key: nodeKey, error: message });
  }

  /** 下游失效（不删除产物，保留版本用于对比） */
  invalidateDownstream(runId, fromKeys, exceptNodeKey) {
    const nodes = all('SELECT * FROM node_runs WHERE run_id = ?', runId);
    const affected = new Set();
    const queue = [...fromKeys];
    while (queue.length) {
      const key = queue.shift();
      for (const node of nodes) {
        if (affected.has(node.node_key)) continue;
        if (jparse(node.depends_on, []).includes(key)) { affected.add(node.node_key); queue.push(node.node_key); }
      }
    }
    if (exceptNodeKey) affected.delete(exceptNodeKey);
    let count = 0;
    for (const key of affected) {
      const node = nodes.find((n) => n.node_key === key);
      if (!['succeeded', 'waiting_human', 'invalidated'].includes(node.status)) continue;
      run("UPDATE node_runs SET status='invalidated', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?", nowIso(), node.id);
      count += 1;
    }
    if (count) this.emit(runId, 'node.invalidated', { nodes: [...affected] });
    return [...affected];
  }

  finishIfDone(runId) {
    const nodes = all('SELECT * FROM node_runs WHERE run_id = ?', runId);
    if (nodes.some((n) => BLOCKING_NODE.has(n.status))) return;
    const failed = nodes.filter((n) => n.status === 'failed');
    if (failed.length) {
      run("UPDATE runs SET status='failed', error_code='WF_NODE_FAILED', updated_at=? WHERE id=?", nowIso(), runId);
      return;
    }
    run("UPDATE runs SET status='completed', finished_at=?, updated_at=? WHERE id=?", nowIso(), nowIso(), runId);
    this.emit(runId, 'run.completed', { artifacts: Object.keys(this.artifacts(runId)) });
  }

  updateContext(runId, mutate) {
    const row = get('SELECT context_json FROM runs WHERE id = ?', runId);
    const ctx = jparse(row?.context_json, {});
    ctx.artifacts ||= {}; ctx.reviews ||= {}; ctx.quality ||= {}; ctx.budget ||= { tokens_used: 0, agent_calls: 0, wall_ms: 0 };
    ctx.flags ||= { veto_pending: false, force_human: false, degraded: false };
    mutate(ctx);
    run('UPDATE runs SET context_json=?, updated_at=? WHERE id=?', jstr(ctx), nowIso(), runId);
  }

  recordReview(runId, { gateKey, level, action, comment, edits, reviewerId }) {
    this.updateContext(runId, (ctx) => {
      ctx.reviews[gateKey] = { level, action, comment: clip(comment, 300), edits: edits || [], at: nowIso(), reviewer_id: reviewerId };
      ctx.decisions_history ||= [];
      ctx.decisions_history.push({ gate_key: gateKey, level, action, comment: clip(comment, 200), at: nowIso() });
    });
  }

  // ---------- 命令 ----------
  pause(runId, userId) {
    run("UPDATE runs SET status='paused', updated_at=? WHERE id=?", nowIso(), runId);
    this.emit(runId, 'run.paused', {}, { type: 'user', id: userId });
  }

  resume(runId, userId) {
    const pending = get("SELECT COUNT(*) AS c FROM review_tasks WHERE run_id=? AND status IN ('pending','in_review')", runId)?.c ?? 0;
    run('UPDATE runs SET status=?, updated_at=? WHERE id=?', pending ? 'waiting_human' : 'running', nowIso(), runId);
    this.emit(runId, 'run.resumed', { pending_reviews: pending }, { type: 'user', id: userId });
    this.tick(runId);
  }

  cancel(runId, userId) {
    // waiting_human 也要收口：否则取消后仍挂着"等待人工"节点，运行看板/恢复对账会自相矛盾
    run("UPDATE node_runs SET status='skipped', lease_owner=NULL, lease_expires_at=NULL, updated_at=? WHERE run_id=? AND status IN ('pending','ready','running','waiting_human')", nowIso(), runId);
    run("UPDATE review_tasks SET status='cancelled', closed_at=?, updated_at=? WHERE run_id=? AND status IN ('pending','in_review')", nowIso(), nowIso(), runId);
    run("UPDATE runs SET status='cancelled', finished_at=?, updated_at=? WHERE id=?", nowIso(), nowIso(), runId);
    this.emit(runId, 'run.cancelled', {}, { type: 'user', id: userId });
  }

  retryNode(runId, nodeKey, userId) {
    const node = get('SELECT * FROM node_runs WHERE run_id=? AND node_key=?', runId, nodeKey);
    if (!node) throw new Error('节点不存在');
    run("UPDATE node_runs SET status='ready', attempt=attempt+1, lease_owner=NULL, lease_expires_at=NULL, error_code=NULL, error_message=NULL, updated_at=? WHERE id=?", nowIso(), node.id);
    run("UPDATE runs SET status='running', updated_at=? WHERE id=?", nowIso(), runId);
    this.emit(runId, 'node.retry_manual', { node_key: nodeKey }, { type: 'user', id: userId });
    this.tick(runId);
  }

  /**
   * 人工跳过节点：只允许显式可跳状态；跳过后视为"已完成"，promoteReady 正常推进下游。
   * 幂等由路由层用 commandId 保证（同一 commandId 直接回放既有结果）。
   */
  skipNode(runId, nodeKey, userId) {
    const node = get('SELECT * FROM node_runs WHERE run_id=? AND node_key=?', runId, nodeKey);
    if (!node) {
      const error = new Error('节点不存在');
      error.code = 'WF_NODE_NOT_FOUND';
      throw error;
    }
    if (!SKIPPABLE.has(node.status)) {
      const error = new Error(`当前状态不可跳过：${node.status}`);
      error.code = 'WF_NODE_NOT_SKIPPABLE';
      throw error;
    }
    tx(() => {
      run(`UPDATE node_runs SET status='skipped', finished_at=?, lease_owner=NULL, lease_expires_at=NULL,
            error_code=NULL, error_message=NULL, updated_at=? WHERE id=?`, nowIso(), nowIso(), node.id);
      // 门禁节点被跳过 → 其待办审核任务作废，避免审核中心残留僵尸任务
      run("UPDATE review_tasks SET status='cancelled', closed_at=?, updated_at=? WHERE run_id=? AND gate_key=? AND status IN ('pending','in_review')",
        nowIso(), nowIso(), runId, nodeKey);
    });
    this.emit(runId, 'node.skipped', { node_key: nodeKey, from_status: node.status }, { type: 'user', id: userId });
    this.promoteReady(runId);
    const pendingReviews = get("SELECT COUNT(*) AS c FROM review_tasks WHERE run_id=? AND status IN ('pending','in_review')", runId)?.c ?? 0;
    const waitingNodes = get("SELECT COUNT(*) AS c FROM node_runs WHERE run_id=? AND status='waiting_human'", runId)?.c ?? 0;
    if (!pendingReviews && !waitingNodes) {
      run("UPDATE runs SET status='running', updated_at=? WHERE id=? AND status='waiting_human'", nowIso(), runId);
    }
    this.tick(runId);
    const runStatus = get('SELECT status FROM runs WHERE id=?', runId)?.status ?? 'running';
    run("UPDATE runs SET updated_at=? WHERE id=?", nowIso(), runId);
    return {
      ok: true,
      node_key: nodeKey,
      node_status: 'skipped',
      previous_status: node.status,
      run_status: runStatus,
    };
  }

  /** 崩溃恢复：重启后把过期租约节点收回，重新入队 */
  reconcile(runId, { force = false } = {}) {
    const now = nowIso();
    const sql = force
      ? "SELECT * FROM node_runs WHERE run_id=? AND status='running'"
      : "SELECT * FROM node_runs WHERE run_id=? AND status='running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)";
    const stale = force ? all(sql, runId) : all(sql, runId, now);
    const interrupted = stale.map((n) => n.node_key);
    const recovered = [];
    for (const node of stale) {
      const res = run("UPDATE node_runs SET status='ready', lease_owner=NULL, lease_expires_at=NULL, error_message=?, updated_at=? WHERE id=?",
        '上次执行被中断，已自动重新入队', nowIso(), node.id);
      if (res.changes > 0) recovered.push(node.node_key);
    }
    this.promoteReady(runId);
    const nodes = all('SELECT node_key, status FROM node_runs WHERE run_id=?', runId);
    const waiting = nodes.filter((n) => n.status === 'waiting_human').map((n) => n.node_key);
    const pendingReviews = get("SELECT COUNT(*) AS c FROM review_tasks WHERE run_id=? AND status IN ('pending','in_review')", runId)?.c ?? 0;
    const runRow = get('SELECT * FROM runs WHERE id=?', runId);
    // 恢复后的运行状态：仍有 waiting_human（节点或审核任务）就保持 waiting_human，否则回 running
    if (runRow && !TERMINAL_RUN.has(runRow.status) && runRow.status !== 'paused') {
      const nextStatus = (waiting.length || pendingReviews) ? 'waiting_human' : 'running';
      if (runRow.status !== nextStatus) run('UPDATE runs SET status=?, updated_at=? WHERE id=?', nextStatus, nowIso(), runId);
    }
    if (stale.length) {
      this.emit(runId, 'run.recovered', {
        interrupted: interrupted.length,
        interrupted_nodes: interrupted,
        recovered,
        waiting,
      });
    }
    this.tick(runId);
    return { interrupted, recovered, waiting };
  }

  /** 周期回收过期租约（进程被杀、节点卡 running 的自愈） */
  reclaimExpired() {
    const now = nowIso();
    const rows = all("SELECT DISTINCT run_id FROM node_runs WHERE status='running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)", now);
    for (const row of rows) {
      const stale = all("SELECT * FROM node_runs WHERE run_id=? AND status='running' AND (lease_expires_at IS NULL OR lease_expires_at < ?)", row.run_id, now);
      for (const node of stale) {
        run("UPDATE node_runs SET status='ready', lease_owner=NULL, lease_expires_at=NULL, error_message=?, updated_at=? WHERE id=?",
          '租约过期，已重新入队', nowIso(), node.id);
      }
      if (stale.length) {
        this.emit(row.run_id, 'run.recovered', { interrupted: stale.length, reason: 'lease_expired' });
        this.promoteReady(row.run_id);
        this.tick(row.run_id);
      }
    }
    return rows.length;
  }

  reconcileAll() {
    const rows = all("SELECT id, status FROM runs WHERE status IN ('running','planning','replanning','interrupted')");
    for (const row of rows) {
      // 单进程部署：启动时任何 running 节点都必然是上次进程遗留，直接收回
      try { this.reconcile(row.id, { force: true }); } catch { /* ignore */ }
    }
  }

  // ---------- Supervisor 可观测 ----------
  /**
   * Supervisor 视图：计划 + 预算 + 决策流水 + 实际并行批次。
   * 决策只聚合 supervisor.* / plan.* / nodes.parallel / node.invalidated 四类事件（事件流是唯一真相）。
   */
  supervisor(runId) {
    const runRow = get('SELECT * FROM runs WHERE id = ?', runId);
    if (!runRow) return null;
    const plan = jparse(runRow.plan_json, null) || { nodes: [], rationale: '', plan_version: runRow.plan_version };
    const ctx = jparse(runRow.context_json, {});
    const budget = jparse(runRow.budget_json, plan.budget || {});
    const digest = planDigest(plan);
    const events = all(
      `SELECT seq, type, actor_type, actor_id, payload_json, created_at FROM events
        WHERE run_id = ? AND (type LIKE 'supervisor.%' OR type LIKE 'plan.%' OR type = 'nodes.parallel' OR type = 'node.invalidated')
        ORDER BY seq ASC`,
      runId,
    );
    const decisions = [];
    const parallel_batches = [];
    for (const e of events) {
      const p = jparse(e.payload_json, {});
      let node_keys = [];
      let targets = [];
      let reason = '';
      if (e.type === 'nodes.parallel') {
        node_keys = Array.isArray(p.nodes) ? p.nodes : [];
        if (node_keys.length) parallel_batches.push(node_keys);
        reason = `并行调度 ${node_keys.length} 个节点（槽位 ${p.slots ?? '-'}）`;
      } else if (e.type === 'node.invalidated') {
        node_keys = Array.isArray(p.nodes) ? p.nodes : [];
        reason = '上游变更 → 下游产物失效';
      } else if (e.type === 'supervisor.plan_created') {
        node_keys = Array.isArray(p.node_keys) ? p.node_keys : [];
        targets = Array.isArray(p.agent_keys) ? p.agent_keys : [];
        reason = p.rationale || '';
      } else if (e.type === 'supervisor.rework') {
        node_keys = Array.isArray(p.node_keys) ? p.node_keys : [];
        targets = Array.isArray(p.target_agents) ? p.target_agents : [];
        reason = `${(p.defect_codes || []).join('/') || '缺陷'}：${p.reason || ''}`;
      } else if (e.type === 'supervisor.replan') {
        node_keys = Array.isArray(p.targets) ? p.targets : [];
        reason = (p.reasons || []).join('；') || p.rationale || '';
      } else if (e.type === 'supervisor.budget_warning') {
        reason = `预算已达 ${(Number(p.ratio ?? 0) * 100).toFixed(0)}%，跳过第二次评委`;
      } else if (e.type === 'plan.created') {
        reason = p.reason || p.rationale || '';
      } else if (e.type === 'plan.fallback') {
        reason = `兜底计划：${p.reason || ''}`;
      } else if (e.type === 'plan.revised') {
        node_keys = Array.isArray(p.targets) ? p.targets : [];
        reason = (p.reasons || []).join('；');
      } else if (e.type === 'plan.revise_failed') {
        reason = `重规划失败：${p.reason || ''}`;
      }
      decisions.push({
        at: e.created_at,
        seq: e.seq,
        type: e.type,
        reason: clip(reason, 300),
        targets,
        node_keys,
        actor: { type: e.actor_type, id: e.actor_id },
      });
    }
    const used = {
      tokens: Number(ctx.budget?.tokens_used || 0),
      agent_calls: Number(ctx.budget?.agent_calls || 0),
      wall_ms: Number(ctx.budget?.wall_ms || 0),
    };
    const maxTokens = Number(budget.max_tokens || 0);
    return {
      run_id: runId,
      run_status: runRow.status,
      plan: {
        plan_version: digest.plan_version,
        objective: plan.objective ?? runRow.objective,
        rationale: plan.rationale ?? '',
        source: plan.source ?? digest.source,
        nodes: (plan.nodes || []).map((n) => ({
          node_key: n.node_key,
          agent_key: n.agent_key,
          node_type: n.node_type,
          depends_on: n.depends_on || [],
          review_policy_key: n.review_policy_key ?? null,
        })),
        node_count: digest.node_count,
        agent_keys: digest.agent_keys,
        planned_parallel_groups: digest.parallel_groups,
        stop_conditions: plan.stop_conditions || [],
      },
      plan_version: Number(runRow.plan_version || digest.plan_version),
      rationale: plan.rationale ?? '',
      budget,
      used,
      budget_ratio: maxTokens ? Number((used.tokens / maxTokens).toFixed(4)) : 0,
      budget_warning: Boolean(ctx.flags?.budget_warning),
      decisions,
      parallel_batches,
    };
  }

  // ---------- 快照 ----------
  snapshot(runId) {
    const runRow = get('SELECT * FROM runs WHERE id = ?', runId);
    if (!runRow) return null;
    const project = get('SELECT id, name, code, bidder_name FROM projects WHERE id = ?', runRow.project_id);
    const nodes = all('SELECT * FROM node_runs WHERE run_id = ? ORDER BY rowid ASC', runId).map((n) => ({
      ...n,
      depends_on: jparse(n.depends_on, []),
      feedback: jparse(n.output_json, {})?.review_feedback ?? null,
    }));
    const artifacts = all('SELECT id, kind, version, status, sha256, summary, created_at FROM artifacts WHERE run_id = ? ORDER BY kind, version DESC', runId);
    const reviews = all('SELECT id, gate_key, level, level_total, status, assignee_id, sla_due_at, priority, artifact_kind, artifact_version FROM review_tasks WHERE run_id = ? ORDER BY created_at ASC', runId);
    const quality = all('SELECT id, node_key, iteration, total_score, verdict, dimension_json, created_at FROM quality_reports WHERE run_id = ? ORDER BY created_at ASC', runId)
      .map((q) => ({ ...q, dimension_json: jparse(q.dimension_json, {}) }));
    const plan = jparse(runRow.plan_json, null);
    return {
      run: { ...runRow, plan_json: undefined, context_json: jparse(runRow.context_json, {}), budget_json: jparse(runRow.budget_json, {}) },
      project,
      plan,
      nodes,
      artifacts,
      reviews,
      quality,
      stats: {
        nodes: nodes.length,
        succeeded: nodes.filter((n) => n.status === 'succeeded').length,
        waiting: nodes.filter((n) => n.status === 'waiting_human').length,
        failed: nodes.filter((n) => n.status === 'failed').length,
        score: quality.at(-1)?.total_score ?? null,
      },
    };
  }
}

export const engine = new Engine();
