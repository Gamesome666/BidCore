// HITL 审核服务：开 gate / ReviewPacket / 四动作决策 / 多级流转 / 评论线程 / 转派 / SLA 扫描。
import { all, get, run, tx, jparse, jstr } from '../db.mjs';
import { id, nowIso, clip } from '../lib/util.mjs';
import { publish } from '../lib/bus.mjs';
import { diffPayload } from './diff.mjs';
import { readOverride } from './quality.mjs';
import { loadSettings } from '../seed.mjs';

const ACTION_STATUS = { approve: 'approved', reject: 'rejected', modify: 'modified', reanalyze: 'reanalyzed' };
const AGENT_LABEL = {
  'parse-tender': '招标分析 Agent', 'bid-strategy': '投标策略 Agent', knowledge: '知识检索 Agent',
  tech: '技术方案 Agent', commercial: '商务标 Agent', compliance: '合规审查 Agent',
  quality: '质量评估 Agent', doc: '文档生成 Agent',
};
const COMMENT_MAX = 4000;
const OPEN_STATUS = new Set(['pending', 'in_review']);

export class ReviewConflict extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

/** 用户展示名（评论/转派/审核历史都要用；查不到就空串，绝不抛错） */
function userName(userId) {
  if (!userId) return '';
  const user = get('SELECT id, username, display_name FROM users WHERE id = ?', userId);
  return user?.display_name || user?.username || '';
}

/** 直接落 events（review 域不能 import engine：engine 已经 import 了本模块，会形成循环依赖） */
function emitRunEvent(runId, type, payload = {}, actor = { type: 'system', id: null }) {
  const seq = Number(get('SELECT MAX(seq) AS m FROM events WHERE run_id=?', runId)?.m ?? 0) + 1;
  run('INSERT INTO events (run_id, seq, type, actor_type, actor_id, payload_json, created_at) VALUES (?,?,?,?,?,?,?)',
    runId, seq, type, actor.type, actor.id, jstr(payload), nowIso());
}

function policyLevels(policyKey) {
  const policy = get('SELECT * FROM review_policies WHERE key = ?', policyKey) || get("SELECT * FROM review_policies WHERE key='default'");
  return jparse(policy?.levels_json, [{ level: 1, role: 'project-owner', sla_minutes: 240, on_timeout: 'remind-only' }]);
}

function resolveAssignee(level, project) {
  if (level.role === 'admin') {
    const admin = get("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1");
    return admin?.id ?? project.owner_id;
  }
  if (String(level.role).startsWith('user:')) return Number(String(level.role).slice(5));
  return project.owner_id;
}

/** 打开人工门禁：创建 review_task（level 1）并把事件推给审核中心 */
export function openGate({ run: runRow, node, gateKey, policyKey = 'single', priority = 0, artifactKind = null, artifactVersion = null }) {
  const project = get('SELECT * FROM projects WHERE id = ?', runRow.project_id);
  const levels = policyLevels(policyKey);
  const level = levels[0];
  const slaMinutes = Number(level.sla_minutes || 120);
  const now = Date.now();
  const assignee = resolveAssignee(level, project);
  const task = {
    id: id('rev'),
    run_id: runRow.id,
    node_run_id: node?.id ?? '',
    gate_key: gateKey,
    level: 1,
    level_total: levels.length,
    status: 'pending',
    assignee_id: assignee,
    assignee_role: level.role,
    project_id: runRow.project_id,
    artifact_kind: artifactKind || node?.artifact_kind || gateKey,
    artifact_version: artifactVersion || node?.artifact_version || 1,
    priority,
    remind_at: new Date(now + slaMinutes * 0.75 * 60_000).toISOString(),
    sla_due_at: new Date(now + slaMinutes * 60_000).toISOString(),
    version: 0,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  run(
    `INSERT INTO review_tasks (id, run_id, node_run_id, gate_key, level, level_total, status, assignee_id, assignee_role,
      project_id, artifact_kind, artifact_version, priority, remind_at, sla_due_at, version, created_at, updated_at, policy_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    task.id, task.run_id, task.node_run_id, task.gate_key, task.level, task.level_total, task.status,
    task.assignee_id, task.assignee_role, task.project_id, task.artifact_kind, task.artifact_version, task.priority,
    task.remind_at, task.sla_due_at, task.version, task.created_at, task.updated_at, policyKey,
  );
  publish(runRow.project_id, 'review', {
    type: 'review.opened', review_task_id: task.id, gate_key: gateKey, level: 1,
    level_total: levels.length, assignee_id: assignee, sla_due_at: task.sla_due_at, priority,
  });
  return { reviewTaskId: task.id, level: 1, levelTotal: levels.length };
}

// ---------- 评论线程（决策是不可变裁决，评论是可对话沟通，分表存放） ----------

export function listComments(taskId) {
  return all('SELECT * FROM review_comments WHERE review_task_id = ? ORDER BY created_at ASC', taskId)
    .map((c) => ({
      id: c.id,
      author_id: c.author_id,
      author_name: userName(c.author_id),
      body: c.body,
      kind: c.kind,
      created_at: c.created_at,
    }));
}

export function commentCount(taskId) {
  return get('SELECT COUNT(*) AS c FROM review_comments WHERE review_task_id = ?', taskId)?.c ?? 0;
}

function insertComment(task, { authorId, body, kind }) {
  const comment = {
    id: id('cmt'),
    review_task_id: task.id,
    run_id: task.run_id,
    author_id: authorId,
    body,
    kind,
    created_at: nowIso(),
  };
  run(`INSERT INTO review_comments (id, review_task_id, run_id, author_id, body, kind, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    comment.id, comment.review_task_id, comment.run_id, comment.author_id, comment.body, comment.kind, comment.created_at);
  // comment_count 以实际行数为准（既满足 +1 语义，又不会被历史脏数据带偏）
  run('UPDATE review_tasks SET comment_count = (SELECT COUNT(*) FROM review_comments WHERE review_task_id = ?), updated_at = ? WHERE id = ?',
    task.id, nowIso(), task.id);
  publish(task.project_id, 'review', {
    type: 'review.commented', review_task_id: task.id, comment_id: comment.id,
    author_id: authorId, kind, gate_key: task.gate_key, level: task.level,
  });
  return comment;
}

/** 追加人工评论：1 ≤ 长度 ≤ 4000 */
export function addComment(task, { authorId, body }) {
  const text = String(body ?? '').trim();
  if (text.length < 1) throw new ReviewConflict('REVIEW_COMMENT_TOO_SHORT');
  if (text.length > COMMENT_MAX) throw new ReviewConflict('REVIEW_COMMENT_TOO_LONG');
  const comment = insertComment(task, { authorId, body: text, kind: 'comment' });
  return { ...comment, author_name: userName(authorId), comment_count: commentCount(task.id) };
}

/** 系统评论：升级 / 转派 / 自动通过等由服务端写入，kind='system' */
export function addSystemComment(task, body, { authorId = 0, authorName = '系统' } = {}) {
  const comment = insertComment(task, { authorId, body: clip(String(body ?? ''), COMMENT_MAX), kind: 'system' });
  return { ...comment, author_name: authorName, comment_count: commentCount(task.id) };
}

/**
 * 转派：admin 或项目 owner 可操作。
 * 语义：换人 + 重置 SLA 到 policy 对应级别时长 + 系统评论 + review.reassigned 事件 + 乐观锁版本 +1。
 */
export function reassign(engine, taskId, { assigneeId, actor }) {
  const task = get('SELECT * FROM review_tasks WHERE id = ?', taskId);
  if (!task) throw new ReviewConflict('REVIEW_NOT_FOUND');
  const project = get('SELECT * FROM projects WHERE id = ?', task.project_id);
  if (!(actor?.role === 'admin' || project?.owner_id === actor?.id)) throw new ReviewConflict('REVIEW_FORBIDDEN');
  if (!OPEN_STATUS.has(task.status)) throw new ReviewConflict('REVIEW_ALREADY_DECIDED');
  const target = get('SELECT id, username, display_name, role FROM users WHERE id = ?', Number(assigneeId) || 0);
  if (!target) throw new ReviewConflict('REVIEW_ASSIGNEE_NOT_FOUND');

  const policyKey = task.policy_key || 'default';
  const levels = policyLevels(policyKey);
  const level = levels.find((l) => Number(l.level) === Number(task.level)) || levels[0] || {};
  const slaMinutes = Number(level.sla_minutes || 120);
  const now = Date.now();
  const remindAt = new Date(now + slaMinutes * 0.75 * 60_000).toISOString();
  const dueAt = new Date(now + slaMinutes * 60_000).toISOString();
  const assigneeRole = target.role === 'admin' ? 'admin' : `user:${target.id}`;
  const fromId = task.assignee_id;
  const fromName = userName(fromId) || '未指派';
  const toName = target.display_name || target.username;

  run(`UPDATE review_tasks SET assignee_id=?, assignee_role=?, remind_at=?, sla_due_at=?, reminded_at=NULL,
        version=version+1, updated_at=? WHERE id=?`,
    target.id, assigneeRole, remindAt, dueAt, nowIso(), task.id);
  const comment = addSystemComment(task, `转派：${fromName} → ${toName}（操作人 ${actor.display_name || actor.username || 'system'}；SLA 重置为 ${slaMinutes} 分钟）`, {
    authorId: actor.id,
    authorName: actor.display_name || actor.username || '系统',
  });
  engine?.emit?.(task.run_id, 'review.reassigned', {
    review_task_id: task.id,
    gate_key: task.gate_key,
    level: task.level,
    from_assignee_id: fromId,
    to_assignee_id: target.id,
    to_assignee_name: toName,
    sla_due_at: dueAt,
    policy_key: policyKey,
    comment_id: comment.id,
  }, { type: 'user', id: actor.id });
  publish(task.project_id, 'review', {
    type: 'review.reassigned', review_task_id: task.id,
    assignee_id: target.id, assignee_name: toName, sla_due_at: dueAt,
  });
  return {
    ok: true,
    review_task_id: task.id,
    assignee_id: target.id,
    assignee_name: toName,
    assignee_role: assigneeRole,
    remind_at: remindAt,
    sla_due_at: dueAt,
    policy_key: policyKey,
    comment_id: comment.id,
    comment_count: comment.comment_count,
  };
}

export function listReviews({ status, assigneeId, projectId, overdue, role } = {}) {
  const where = [];
  const params = [];
  if (status) { where.push('status = ?'); params.push(status); }
  if (assigneeId) { where.push('assignee_id = ?'); params.push(assigneeId); }
  if (projectId) { where.push('project_id = ?'); params.push(projectId); }
  if (overdue) { where.push("status='pending' AND sla_due_at < ?"); params.push(nowIso()); }
  const sql = `SELECT * FROM review_tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY priority DESC, sla_due_at ASC LIMIT 200`;
  const rows = all(sql, ...params);
  return rows.map((r) => ({
    ...r,
    level_total: r.level_total,
    overdue: r.status === 'pending' && r.sla_due_at < nowIso(),
    minutes_left: Math.round((new Date(r.sla_due_at).getTime() - Date.now()) / 60000),
    project_name: get('SELECT name FROM projects WHERE id = ?', r.project_id)?.name ?? '',
    run_status: get('SELECT status FROM runs WHERE id = ?', r.run_id)?.status ?? '',
    agent_label: AGENT_LABEL[r.gate_key] ?? r.gate_key,
  }));
}

export function reviewSummary(userId, isAdmin) {
  const mine = get("SELECT COUNT(*) AS c FROM review_tasks WHERE status='pending' AND assignee_id = ?", userId)?.c ?? 0;
  const allOpen = get("SELECT COUNT(*) AS c FROM review_tasks WHERE status='pending'")?.c ?? 0;
  const overdue = get("SELECT COUNT(*) AS c FROM review_tasks WHERE status='pending' AND sla_due_at < ?", nowIso())?.c ?? 0;
  return { mine, all: allOpen, overdue, is_admin: isAdmin };
}

function ancestorNodes(nodeRows, gateKey) {
  const byKey = new Map(nodeRows.map((n) => [n.node_key, n]));
  const seen = new Set();
  const queue = [...(jparse(byKey.get(gateKey)?.depends_on, []))];
  while (queue.length) {
    const k = queue.shift();
    if (seen.has(k)) continue;
    seen.add(k);
    queue.push(...jparse(byKey.get(k)?.depends_on, []));
  }
  return seen;
}

function resolveTargets(nodeRows, gateKey, targets) {
  if (!targets?.length) throw new ReviewConflict('REVIEW_TARGET_REQUIRED');
  const ancestors = ancestorNodes(nodeRows, gateKey);
  const keys = [];
  for (const agent of targets) {
    const hit = nodeRows.filter((n) => n.agent_key === agent && ancestors.has(n.node_key)).map((n) => n.node_key);
    if (!hit.length) throw new ReviewConflict('REVIEW_TARGET_NOT_ANCESTOR');
    keys.push(...hit);
  }
  return [...new Set(keys)];
}

/**
 * reanalyze 语义：旧产物不是"被覆盖"，而是"被取代"——标 superseded 保留可对比，
 * 不删除历史版本（版本链 / diff / 审核留痕都靠它）。
 */
function supersedeArtifacts(runId, targetKeys, nodeRows) {
  const superseded = [];
  for (const key of targetKeys) {
    const node = nodeRows.find((n) => n.node_key === key);
    if (!node) continue;
    const rows = node.artifact_kind
      ? all("SELECT id, kind, version FROM artifacts WHERE run_id=? AND kind=? AND status='active'", runId, node.artifact_kind)
      : all("SELECT id, kind, version FROM artifacts WHERE run_id=? AND node_run_id=? AND status='active'", runId, node.id);
    for (const row of rows) {
      run("UPDATE artifacts SET status='superseded' WHERE id=?", row.id);
      superseded.push({ node_key: key, kind: row.kind, version: row.version });
    }
  }
  return superseded;
}

/** ReviewPacket：一次渲染所需的全部数据（viewer 用于计算 can_reassign，可省略） */
export function buildPacket(task, viewer = null) {
  const runRow = get('SELECT * FROM runs WHERE id = ?', task.run_id);
  const nodeRows = all('SELECT * FROM node_runs WHERE run_id = ?', task.run_id);
  const artifact = get('SELECT * FROM artifacts WHERE run_id = ? AND kind = ? ORDER BY version DESC LIMIT 1', task.run_id, task.artifact_kind);
  const prev = artifact
    ? get('SELECT * FROM artifacts WHERE run_id = ? AND kind = ? AND version < ? ORDER BY version DESC LIMIT 1', task.run_id, task.artifact_kind, artifact.version)
    : null;
  const quality = get('SELECT * FROM quality_reports WHERE run_id = ? ORDER BY created_at DESC LIMIT 1', task.run_id);
  const history = all('SELECT * FROM review_decisions WHERE run_id = ? ORDER BY created_at ASC', task.run_id);
  const ancestors = ancestorNodes(nodeRows, task.gate_key);
  const targets = [...new Set(nodeRows.filter((n) => ancestors.has(n.node_key)).map((n) => n.agent_key))]
    .filter((a) => AGENT_LABEL[a])
    .map((a) => ({ agent_key: a, label: AGENT_LABEL[a] }));

  // 多级进度：已实例化的审核任务 + policy 里尚未到达的级别（status='queued'）
  const policyKey = task.policy_key || 'default';
  const levels = policyLevels(policyKey);
  const gateTasks = all('SELECT * FROM review_tasks WHERE run_id = ? AND gate_key = ? ORDER BY level ASC, created_at ASC', task.run_id, task.gate_key);
  const levelTrack = gateTasks.map((t) => ({
    level: t.level,
    status: t.status,
    role: t.assignee_role || null,
    assignee_id: t.assignee_id ?? null,
    assignee_name: userName(t.assignee_id),
    sla_due_at: t.sla_due_at ?? null,
    review_task_id: t.id,
    current: t.id === task.id,
  }));
  for (const level of levels) {
    const covered = gateTasks.some((t) => Number(t.level) === Number(level.level) && (t.assignee_role || '') === (level.role || ''));
    if (covered) continue;
    if (gateTasks.some((t) => Number(t.level) === Number(level.level)) && levels.filter((l) => Number(l.level) === Number(level.level)).length === 1) continue;
    levelTrack.push({
      level: Number(level.level),
      status: 'queued',
      role: level.role || null,
      assignee_id: null,
      assignee_name: '',
      sla_due_at: null,
      review_task_id: null,
      current: false,
      on_timeout: level.on_timeout || 'remind-only',
    });
  }

  // 上游审核意见：跨 gate 传递（review_decisions 是裁决台账，context.reviews 是运行时摘要）
  const decisions = all('SELECT * FROM review_decisions WHERE run_id = ? ORDER BY created_at ASC', task.run_id);
  const contextReviews = jparse(runRow?.context_json, {})?.reviews || {};
  const upstream = [];
  for (const d of decisions) {
    if (d.gate_key === task.gate_key) continue;
    upstream.push({
      gate_key: d.gate_key,
      level: d.level,
      action: d.action,
      comment: clip(d.comment || '', 240),
      reviewer_name: userName(d.reviewer_id),
      at: d.created_at,
      source: 'decision',
    });
  }
  for (const [gateKey, r] of Object.entries(contextReviews)) {
    if (gateKey === task.gate_key || !r) continue;
    const dup = upstream.some((u) => u.gate_key === gateKey && Number(u.level) === Number(r.level) && u.action === r.action);
    if (dup) continue;
    upstream.push({
      gate_key: gateKey,
      level: Number(r.level ?? 1),
      action: r.action || 'unknown',
      comment: clip(r.comment || '', 240),
      reviewer_name: userName(r.reviewer_id) || String(r.reviewer_name || ''),
      at: r.at || null,
      source: 'context',
    });
  }
  upstream.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));

  const projectRow = get('SELECT id, name, code, bidder_name, owner_id FROM projects WHERE id = ?', task.project_id);
  const canReassign = Boolean(viewer) && OPEN_STATUS.has(task.status)
    && (viewer.role === 'admin' || projectRow?.owner_id === viewer.id);
  const commentsTotal = Math.max(commentCount(task.id), Number(task.comment_count || 0));

  const beforePayload = prev ? jparse(prev.payload_json, null) : null;
  const afterPayload = artifact ? jparse(artifact.payload_json, null) : null;
  const beforeText = typeof beforePayload === 'string' ? beforePayload : beforePayload?.markdown;
  const afterText = typeof afterPayload === 'string' ? afterPayload : afterPayload?.markdown;
  const diff = beforePayload === null
    ? { mode: 'none', ops: [] }
    : (typeof beforeText === 'string' && typeof afterText === 'string'
      ? diffPayload(beforeText, afterText)
      : diffPayload(beforePayload, afterPayload));

  return {
    review_task_id: task.id,
    run_id: task.run_id,
    run_status: runRow?.status,
    gate_key: task.gate_key,
    gate_label: AGENT_LABEL[task.gate_key] ? `质量门禁：${AGENT_LABEL[task.gate_key]}` : task.gate_key,
    level: task.level,
    level_total: task.level_total,
    status: task.status,
    priority: task.priority,
    policy_key: policyKey,
    project: projectRow ? {
      id: projectRow.id, name: projectRow.name, code: projectRow.code, bidder_name: projectRow.bidder_name,
    } : null,
    subject: {
      artifact_kind: task.artifact_kind,
      version: artifact?.version ?? task.artifact_version,
      summary: artifact?.summary ?? '',
      payload: afterPayload,
      provenance: artifact ? jparse(artifact.provenance_json, {}) : {},
    },
    quality: quality ? {
      total: quality.total_score,
      verdict: quality.verdict,
      dimensions: jparse(quality.dimension_json, {}),
      findings: jparse(quality.findings_json, []),
      judge: jparse(quality.judge_json, {}),
      iteration: quality.iteration,
      report_id: quality.id,
      override: readOverride(jparse(quality.judge_json, {})),
    } : null,
    diff,
    history: history.map((h) => ({
      level: h.level, action: h.action, comment: h.comment,
      reviewer: get('SELECT display_name, username FROM users WHERE id = ?', h.reviewer_id),
      at: h.created_at, targets: jparse(h.targets_json, []),
    })),
    allowed_actions: ['approve', 'reject', 'modify', 'reanalyze'],
    targets,
    allowed_targets: targets,
    level_track: levelTrack,
    upstream_reviews: upstream,
    comments_count: commentsTotal,
    can_reassign: canReassign,
    sla: {
      remind_at: task.remind_at, due_at: task.sla_due_at,
      minutes_left: Math.round((new Date(task.sla_due_at).getTime() - Date.now()) / 60000),
      overdue: task.sla_due_at < nowIso(),
    },
    escalation: {
      escalated_from: task.escalated_from ?? null,
      escalated_to: task.escalated_to ?? null,
    },
    run_brief: runRow ? { status: runRow.status, plan_version: runRow.plan_version, objective: runRow.objective } : null,
  };
}

/** 四动作决策（幂等 + 乐观锁 + 事务） */
export async function decide(engine, taskId, input) {
  const existing = get('SELECT * FROM commands WHERE command_id = ?', input.commandId);
  if (existing) return jparse(existing.result_json, { success: true });

  const task = get('SELECT * FROM review_tasks WHERE id = ?', taskId);
  if (!task) throw new ReviewConflict('REVIEW_NOT_FOUND');
  if (!['pending', 'in_review'].includes(task.status)) throw new ReviewConflict('REVIEW_ALREADY_DECIDED');
  if (input.action !== 'approve' && String(input.comment || '').trim().length < 10) throw new ReviewConflict('REVIEW_COMMENT_TOO_SHORT');

  const runRow = get('SELECT * FROM runs WHERE id = ?', task.run_id);
  const nodeRows = all('SELECT * FROM node_runs WHERE run_id = ?', task.run_id);
  const gate = nodeRows.find((n) => n.node_key === task.gate_key);
  if (!gate) throw new ReviewConflict('REVIEW_GATE_MISSING');
  const targetKeys = input.action === 'approve' ? [] : resolveTargets(nodeRows, task.gate_key, input.targets);

  const outcome = tx(() => {
    const locked = run(
      `UPDATE review_tasks SET status=?, version=version+1, closed_at=?, updated_at=? WHERE id=? AND status=? AND version=?`,
      ACTION_STATUS[input.action], nowIso(), nowIso(), task.id, task.status, task.version,
    );
    if (locked.changes === 0) throw new ReviewConflict('REVIEW_ALREADY_DECIDED');

    run(
      `INSERT INTO review_decisions (id, review_task_id, run_id, gate_key, level, action, reviewer_id, comment, targets_json, edits_json, evidence_json, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id('dec'), task.id, task.run_id, task.gate_key, task.level, input.action, input.reviewerId,
      input.comment || '', jstr(input.targets || []), jstr(input.edits || []), jstr(input.evidence || {}), nowIso(),
    );

    let nextReview = null;
    let supersededNow = [];
    const planNodes = jparse(runRow.plan_json, { nodes: [] }).nodes || [];
    const gateSpec = planNodes.find((n) => n.node_key === task.gate_key);
    const decisionPolicyKey = task.policy_key || gateSpec?.review_policy_key || 'default';
    const levels = policyLevels(decisionPolicyKey);
    const levelTotal = task.level_total;
    const nextLevel = task.level + 1;

    if (input.action === 'approve' && nextLevel <= levelTotal) {
      const level = levels.find((l) => l.level === nextLevel) || { level: nextLevel, role: 'admin', sla_minutes: 240 };
      const project = get('SELECT * FROM projects WHERE id = ?', task.project_id);
      const assignee = resolveAssignee(level, project);
      const created = {
        id: id('rev'), run_id: task.run_id, node_run_id: task.node_run_id, gate_key: task.gate_key,
        level: nextLevel, level_total: levelTotal, status: 'pending', assignee_id: assignee,
        assignee_role: level.role, project_id: task.project_id, artifact_kind: task.artifact_kind,
        artifact_version: task.artifact_version, priority: task.priority,
        remind_at: new Date(Date.now() + Number(level.sla_minutes || 240) * 0.75 * 60_000).toISOString(),
        sla_due_at: new Date(Date.now() + Number(level.sla_minutes || 240) * 60_000).toISOString(),
        version: 0,
      };
      run(
        `INSERT INTO review_tasks (id, run_id, node_run_id, gate_key, level, level_total, status, assignee_id, assignee_role,
          project_id, artifact_kind, artifact_version, priority, remind_at, sla_due_at, version, created_at, updated_at, policy_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        created.id, created.run_id, created.node_run_id, created.gate_key, created.level, created.level_total, created.status,
        created.assignee_id, created.assignee_role, created.project_id, created.artifact_kind, created.artifact_version,
        created.priority, created.remind_at, created.sla_due_at, created.version, nowIso(), nowIso(), decisionPolicyKey,
      );
      nextReview = { id: created.id, level: nextLevel };
      run('UPDATE node_runs SET status=?, updated_at=? WHERE id=?', 'waiting_human', nowIso(), gate.id);
    } else if (input.action === 'approve') {
      run("UPDATE artifacts SET status='frozen' WHERE run_id=? AND kind=? AND version=?", task.run_id, task.artifact_kind, task.artifact_version);
      run('UPDATE node_runs SET status=?, finished_at=?, updated_at=? WHERE id=?', 'succeeded', nowIso(), nowIso(), gate.id);
    } else {
      // reanalyze：旧产物显式标 superseded（保留版本用于对比），再由目标节点重新产出 v(N+1)
      if (input.action === 'reanalyze') supersededNow = supersedeArtifacts(task.run_id, targetKeys, nodeRows);
      for (const key of targetKeys) {
        const node = nodeRows.find((n) => n.node_key === key);
        const deps = jparse(node.depends_on, []);
        const depsDone = deps.every((d) => {
          const dn = nodeRows.find((x) => x.node_key === d);
          return dn && (dn.status === 'succeeded' || dn.status === 'skipped');
        });
        // attempt / iteration 逐节点独立自增：每个目标节点自己记自己跑了几次
        run(
          `UPDATE node_runs SET status=?, attempt=attempt+1, iteration=iteration+1, lease_owner=NULL, lease_expires_at=NULL,
             error_code=NULL, error_message=NULL, output_json=?, updated_at=? WHERE id=?`,
          depsDone ? 'ready' : 'pending',
          jstr({ review_feedback: { action: input.action, comment: input.comment, edits: input.edits || [], targets: input.targets || [] } }),
          nowIso(), node.id,
        );
      }
      run("UPDATE runs SET status='running', updated_at=? WHERE id=?", nowIso(), task.run_id);
    }

    const result = {
      success: true, action: input.action,
      node_status: input.action === 'approve' ? (nextReview ? 'waiting_human' : 'succeeded') : 'rerouted',
      next_review: nextReview, target_nodes: targetKeys, run_status: jgetRunStatus(task.run_id),
      policy_key: decisionPolicyKey,
      superseded_artifacts: input.action === 'reanalyze' ? supersededNow : [],
    };
    run('INSERT INTO commands (id, run_id, command_id, type, payload_json, status, result_json, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id('cmd'), task.run_id, input.commandId, 'review-decision', jstr({ review_task_id: task.id, action: input.action }), 'applied', jstr(result), nowIso());
    run('INSERT INTO events (run_id, seq, type, actor_type, actor_id, payload_json, created_at) VALUES (?,?,?,?,?,?,?)',
      task.run_id, engine.nextSeq(task.run_id), 'review.decided', 'user', input.reviewerId,
      jstr({ gate_key: task.gate_key, level: task.level, action: input.action, comment: clip(input.comment || '', 300), targets: input.targets || [] }), nowIso());
    return result;
  });

  publish(task.project_id, 'workflow', { type: 'review.decided', run_id: task.run_id, gate_key: task.gate_key, level: task.level, action: input.action });
  publish(task.project_id, 'review', { type: 'review.decided', review_task_id: task.id, action: input.action, gate_key: task.gate_key, level: task.level });

  // 人工返工也是 Supervisor 决策：写进 supervisor.rework，运行详情/决策视图能看到"人让谁重做、为什么"
  if (['reject', 'modify', 'reanalyze'].includes(outcome.action)) {
    engine?.emitSupervisor?.(task.run_id, 'supervisor.rework', {
      trigger: 'human',
      gate_key: task.gate_key,
      level: task.level,
      action: outcome.action,
      target_agents: input.targets || [],
      node_keys: (outcome.target_nodes || []).slice(0, 12),
      reason: clip(input.comment || '', 200),
      superseded: (outcome.superseded_artifacts || []).length,
    }, { type: 'user', id: input.reviewerId });
  }

  if (!outcome.next_review) {
    if (outcome.action === 'approve') {
      engine.promoteReady(task.run_id);
    } else {
      engine.invalidateDownstream(task.run_id, outcome.target_nodes);
      engine.promoteReady(task.run_id);
    }
    const runStatus = get('SELECT status FROM runs WHERE id=?', task.run_id)?.status;
    if (runStatus === 'waiting_human') run("UPDATE runs SET status='running', updated_at=? WHERE id=?", nowIso(), task.run_id);
    engine.tick(task.run_id);
  }
  return outcome;
}

function jgetRunStatus(runId) {
  return get('SELECT status FROM runs WHERE id=?', runId)?.status ?? 'running';
}

/**
 * SLA 扫描：提醒（remind_at）→ 到期按 policy 的 on_timeout 处理。
 *  · escalate   ：升级到下一级（写 escalated_from + 系统评论 + review.escalated 事件）
 *  · auto-pass  ：仅当 settings.review.allow_auto_pass===true 时生效；默认关闭，绝不能被硬编码打开
 *  · remind-only：重复提醒（默认）
 */
export function allowAutoPass() {
  const settings = loadSettings();
  const review = settings.review || {};
  return review.allow_auto_pass === true || review.allowAutoPass === true;
}

/**
 * auto-pass 之后推进门禁（与人工 approve 语义对齐）：
 *  · 还有下一级 → 生成下一级 pending 任务；
 *  · 已是末级 → 冻结产物、门禁节点 succeeded，并把 run 置 running（由调度循环 promoteReady 推进下游）。
 */
function advanceGateAfterAutoPass(task, levels) {
  const gate = get('SELECT * FROM node_runs WHERE run_id=? AND node_key=?', task.run_id, task.gate_key);
  const nextLevel = Number(task.level) + 1;
  if (nextLevel <= Number(task.level_total)) {
    const level = levels.find((l) => Number(l.level) === nextLevel) || { role: 'admin', sla_minutes: 240 };
    const project = get('SELECT * FROM projects WHERE id=?', task.project_id);
    const assignee = resolveAssignee(level, project);
    const slaMinutes = Number(level.sla_minutes || 240);
    run(`INSERT INTO review_tasks (id, run_id, node_run_id, gate_key, level, level_total, status, assignee_id, assignee_role,
          project_id, artifact_kind, artifact_version, priority, remind_at, sla_due_at, version, created_at, updated_at, policy_key)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id('rev'), task.run_id, task.node_run_id, task.gate_key, nextLevel, task.level_total, 'pending',
      assignee, level.role, task.project_id, task.artifact_kind, task.artifact_version, task.priority,
      new Date(Date.now() + slaMinutes * 0.75 * 60_000).toISOString(),
      new Date(Date.now() + slaMinutes * 60_000).toISOString(),
      0, nowIso(), nowIso(), task.policy_key || 'default');
    return;
  }
  if (gate) {
    run('UPDATE artifacts SET status=? WHERE run_id=? AND kind=? AND version=?', 'frozen', task.run_id, task.artifact_kind, task.artifact_version);
    run('UPDATE node_runs SET status=?, finished_at=?, updated_at=? WHERE id=?', 'succeeded', nowIso(), nowIso(), gate.id);
    const others = get("SELECT COUNT(*) AS c FROM node_runs WHERE run_id=? AND status='waiting_human'", task.run_id)?.c ?? 0;
    const pending = get("SELECT COUNT(*) AS c FROM review_tasks WHERE run_id=? AND status IN ('pending','in_review')", task.run_id)?.c ?? 0;
    if (!others && !pending) run("UPDATE runs SET status='running', updated_at=? WHERE id=? AND status='waiting_human'", nowIso(), task.run_id);
  }
}

export function scanSla() {
  const now = nowIso();
  const due = all("SELECT * FROM review_tasks WHERE status='pending' AND remind_at <= ? AND reminded_at IS NULL", now);
  for (const t of due) {
    const claimed = run('UPDATE review_tasks SET reminded_at=? WHERE id=? AND reminded_at IS NULL', now, t.id);
    if (claimed.changes === 0) continue;
    publish(t.project_id, 'review', { type: 'review.reminded', review_task_id: t.id, gate_key: t.gate_key, level: t.level, due_at: t.sla_due_at });
  }

  const autoPassAllowed = allowAutoPass();
  const overdue = all("SELECT * FROM review_tasks WHERE status='pending' AND sla_due_at <= ?", now);
  for (const t of overdue) {
    const policyKey = t.policy_key || 'default';
    const levels = policyLevels(policyKey);
    const level = levels.find((l) => Number(l.level) === Number(t.level)) || {};
    const action = level.on_timeout || 'remind-only';

    if (action === 'escalate' && t.level < t.level_total) {
      const claimed = run("UPDATE review_tasks SET status='escalated', version=version+1, closed_at=?, updated_at=? WHERE id=? AND status='pending' AND version=?", now, now, t.id, t.version);
      if (!claimed.changes) continue;
      const nextLevel = t.level + 1;
      const next = levels.find((l) => Number(l.level) === nextLevel) || { role: 'admin', sla_minutes: 240 };
      const project = get('SELECT * FROM projects WHERE id=?', t.project_id);
      const nextAssignee = resolveAssignee(next, project);
      const nextDue = new Date(Date.now() + Number(next.sla_minutes || 240) * 60_000).toISOString();
      const nextRemind = new Date(Date.now() + Number(next.sla_minutes || 240) * 0.75 * 60_000).toISOString();
      const newTaskId = id('rev');
      run(
        `INSERT INTO review_tasks (id, run_id, node_run_id, gate_key, level, level_total, status, assignee_id, assignee_role,
          project_id, artifact_kind, artifact_version, priority, remind_at, sla_due_at, version, created_at, updated_at,
          policy_key, escalated_from)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        newTaskId, t.run_id, t.node_run_id, t.gate_key, nextLevel, t.level_total, 'pending',
        nextAssignee, next.role, t.project_id, t.artifact_kind, t.artifact_version, 1,
        nextRemind, nextDue,
        0, nowIso(), nowIso(), policyKey, t.level,
      );
      const escalationBody = `SLA 超时自动升级：第 ${t.level} 级（${userName(t.assignee_id) || t.assignee_role}）→ 第 ${nextLevel} 级（${userName(nextAssignee) || next.role}），新截止 ${nextDue}`;
      addSystemComment(t, escalationBody);
      const nextTaskRow = get('SELECT * FROM review_tasks WHERE id=?', newTaskId);
      if (nextTaskRow) addSystemComment(nextTaskRow, `由第 ${t.level} 级超时升级而来（原任务 ${t.id}）`);
      const runRow = get('SELECT * FROM runs WHERE id=?', t.run_id);
      if (runRow) {
        emitRunEvent(t.run_id, 'review.escalated', {
          review_task_id: t.id,
          new_review_task_id: newTaskId,
          gate_key: t.gate_key,
          from_level: t.level,
          to_level: nextLevel,
          policy_key: policyKey,
          sla_due_at: nextDue,
          reason: 'sla_timeout',
        });
      }
      publish(t.project_id, 'review', { type: 'review.escalated', review_task_id: t.id, new_review_task_id: newTaskId, to_level: nextLevel });
    } else if (action === 'auto-pass' && autoPassAllowed) {
      const claimed = run("UPDATE review_tasks SET status='approved', version=version+1, closed_at=?, updated_at=? WHERE id=? AND status='pending' AND version=?",
        now, now, t.id, t.version);
      if (!claimed.changes) continue;
      addSystemComment(t, `SLA 超时按策略自动通过（review.allow_auto_pass=true，策略 ${policyKey} 第 ${t.level} 级）`);
      advanceGateAfterAutoPass(t, levels);
      publish(t.project_id, 'review', { type: 'review.auto_passed', review_task_id: t.id, gate_key: t.gate_key, level: t.level });
    } else if (action === 'remind-only' || action === 'auto-pass') {
      // auto-pass 未被允许时退化为重复提醒（绝不默认放行）
      publish(t.project_id, 'review', { type: 'review.overdue', review_task_id: t.id, gate_key: t.gate_key, level: t.level, auto_pass_blocked: action === 'auto-pass' });
      run('UPDATE review_tasks SET remind_at=?, reminded_at=NULL, updated_at=? WHERE id=? AND status=?',
        new Date(Date.now() + 30 * 60_000).toISOString(), nowIso(), t.id, 'pending');
    }
  }
}
