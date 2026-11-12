// 审核域：/api/reviews*（列表、汇总、审核包、决策、催办、历史、评论、转派）。顺序不可调整：
// /api/reviews/summary 必须先于 /api/reviews/:id 注册，否则会被参数路由吞掉。
import { all, get, run, jparse, jstr } from '../db.mjs';
import { id, nowIso } from '../lib/util.mjs';
import { sendJson, sendError, readBody } from '../lib/http.mjs';
import { publish } from '../lib/bus.mjs';
import { engine } from '../domain/engine.mjs';
import {
  decide, listReviews, reviewSummary, buildPacket, listComments, addComment, reassign, ReviewConflict,
} from '../domain/review.mjs';
import { requireUser } from './_ctx.mjs';

/** 审核任务可见性：管理员 / 当前处理人 / 项目负责人 */
function canViewTask(user, task, project) {
  return user.role === 'admin' || task.assignee_id === user.id || project?.owner_id === user.id;
}

/** 命令幂等：同一 commandId 直接回放既有 results（决策/评论/转派共用） */
function replayCommand(runId, commandId) {
  if (!commandId) return null;
  const row = get('SELECT * FROM commands WHERE run_id=? AND command_id=?', runId, commandId);
  return row ? jparse(row.result_json, { success: true }) : null;
}

function recordCommand(runId, commandId, type, payload, result) {
  if (!commandId) return;
  run('INSERT INTO commands (id, run_id, command_id, type, payload_json, status, result_json, created_at) VALUES (?,?,?,?,?,?,?,?)',
    id('cmd'), runId, commandId, type, jstr(payload), 'applied', jstr(result), nowIso());
}

export function register(router) {
  router.add('GET', '/api/reviews', async ({ req, res, query }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const rows = listReviews({
      status: query.status || undefined,
      assigneeId: query.assignee === 'me' ? user.id : undefined,
      projectId: query.projectId ? Number(query.projectId) : undefined,
      overdue: query.overdue === '1',
    });
    sendJson(res, 200, rows);
  });

  router.add('GET', '/api/reviews/summary', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    sendJson(res, 200, reviewSummary(user.id, user.role === 'admin'));
  });

  router.add('GET', '/api/reviews/:id', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const task = get('SELECT * FROM review_tasks WHERE id=?', params.id);
    if (!task) return sendError(res, 404, 'REVIEW_NOT_FOUND', '审核任务不存在');
    const project = get('SELECT * FROM projects WHERE id=?', task.project_id);
    if (!canViewTask(user, task, project)) {
      return sendError(res, 403, 'REVIEW_FORBIDDEN', '无权查看该审核任务');
    }
    sendJson(res, 200, buildPacket(task, user));
  });

  // ---------- 评论线程 ----------
  router.add('GET', '/api/reviews/:id/comments', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const task = get('SELECT * FROM review_tasks WHERE id=?', params.id);
    if (!task) return sendError(res, 404, 'REVIEW_NOT_FOUND', '审核任务不存在');
    const project = get('SELECT * FROM projects WHERE id=?', task.project_id);
    if (!canViewTask(user, task, project)) return sendError(res, 403, 'REVIEW_FORBIDDEN', '无权查看该审核任务');
    sendJson(res, 200, { comments: listComments(task.id) });
  });

  router.add('POST', '/api/reviews/:id/comments', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const task = get('SELECT * FROM review_tasks WHERE id=?', params.id);
    if (!task) return sendError(res, 404, 'REVIEW_NOT_FOUND', '审核任务不存在');
    const project = get('SELECT * FROM projects WHERE id=?', task.project_id);
    if (!canViewTask(user, task, project)) return sendError(res, 403, 'REVIEW_FORBIDDEN', '无权评论该审核任务');
    const body = await readBody(req);
    const commandId = body.commandId ? String(body.commandId) : '';
    const replayed = replayCommand(task.run_id, commandId);
    if (replayed) return sendJson(res, 200, replayed);
    try {
      const comment = addComment(task, { authorId: user.id, body: body.body ?? body.comment ?? '' });
      const result = { ...comment, comment_count: comment.comment_count, review_task_id: task.id };
      recordCommand(task.run_id, commandId, 'review-comment', { review_task_id: task.id, body: result.body }, result);
      sendJson(res, 201, result);
    } catch (error) {
      if (error instanceof ReviewConflict) return sendError(res, 400, error.code, error.message);
      sendError(res, 500, 'REVIEW_COMMENT_FAILED', String(error.message));
    }
  });

  // ---------- 转派（admin / 项目 owner） ----------
  router.add('POST', '/api/reviews/:id/reassign', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const task = get('SELECT * FROM review_tasks WHERE id=?', params.id);
    if (!task) return sendError(res, 404, 'REVIEW_NOT_FOUND', '审核任务不存在');
    const body = await readBody(req);
    const commandId = body.commandId ? String(body.commandId) : '';
    const replayed = replayCommand(task.run_id, commandId);
    if (replayed) return sendJson(res, 200, replayed);
    if (!body.assigneeId) return sendError(res, 400, 'REVIEW_ASSIGNEE_REQUIRED', '缺少 assigneeId');
    try {
      const result = reassign(engine, task.id, { assigneeId: Number(body.assigneeId), actor: user });
      recordCommand(task.run_id, commandId, 'review-reassign', { review_task_id: task.id, assigneeId: Number(body.assigneeId) }, result);
      sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof ReviewConflict) {
        const status = error.code === 'REVIEW_FORBIDDEN' ? 403 : error.code === 'REVIEW_NOT_FOUND' ? 404 : 409;
        return sendError(res, status, error.code, error.message);
      }
      sendError(res, 500, 'REVIEW_REASSIGN_FAILED', String(error.message));
    }
  });

  router.add('POST', '/api/reviews/:id/decisions', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const task = get('SELECT * FROM review_tasks WHERE id=?', params.id);
    if (!task) return sendError(res, 404, 'REVIEW_NOT_FOUND', '审核任务不存在');
    if (!(user.role === 'admin' || task.assignee_id === user.id || get('SELECT owner_id FROM projects WHERE id=?', task.project_id)?.owner_id === user.id)) {
      return sendError(res, 403, 'REVIEW_FORBIDDEN', '无权处理该审核任务');
    }
    const body = await readBody(req);
    if (!body.commandId) return sendError(res, 400, 'REVIEW_COMMAND_ID_REQUIRED', '缺少 commandId');
    try {
      const result = await decide(engine, params.id, {
        action: String(body.action),
        comment: String(body.comment || ''),
        targets: Array.isArray(body.targets) ? body.targets : [],
        edits: Array.isArray(body.edits) ? body.edits : [],
        commandId: String(body.commandId),
        reviewerId: user.id,
      });
      engine.recordReview(task.run_id, {
        gateKey: task.gate_key, level: task.level, action: body.action,
        comment: body.comment || '', edits: body.edits || [], reviewerId: user.id,
      });
      sendJson(res, 200, result);
    } catch (error) {
      if (error instanceof ReviewConflict) return sendError(res, 409, error.code, error.code);
      sendError(res, 500, 'REVIEW_DECISION_FAILED', String(error.message));
    }
  });

  router.add('POST', '/api/reviews/:id/remind', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const task = get('SELECT * FROM review_tasks WHERE id=?', params.id);
    if (!task) return sendError(res, 404, 'REVIEW_NOT_FOUND', '审核任务不存在');
    publish(task.project_id, 'review', { type: 'review.reminded', review_task_id: task.id, gate_key: task.gate_key, manual: true });
    run('UPDATE review_tasks SET remind_at=?, reminded_at=NULL, updated_at=? WHERE id=?', new Date(Date.now() + 30 * 60_000).toISOString(), nowIso(), task.id);
    sendJson(res, 200, { success: true });
  });

  router.add('GET', '/api/reviews/:id/history', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const rows = all('SELECT * FROM review_decisions WHERE review_task_id=? OR run_id=(SELECT run_id FROM review_tasks WHERE id=?) ORDER BY created_at ASC', params.id, params.id);
    sendJson(res, 200, rows.map((r) => ({ ...r, targets_json: jparse(r.targets_json, []), edits_json: jparse(r.edits_json, []) })));
  });
}
