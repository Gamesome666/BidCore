// 兼容层：复刻原仓库接口（/api/technical-plan、/api/tasks/*、/api/export/docx）
// 以及 SSE 推送 /api/events、导出文件下载 /files/:name、健康检查 /api/health。
//
// 这些端点全部转调新 domain（domain/tasks.mjs 的同一份 project_state），
// 因此旧前端看到的 analysisRaw / outlineData / content / rejectionCheck / duplicateCheck
// 与新工作台看到的是同一批数据，不存在"两套假数据"。
import fs from 'node:fs';
import path from 'node:path';
import { get, run } from '../db.mjs';
import { VAR_DIR } from '../db.mjs';
import { nowIso } from '../lib/util.mjs';
import { sendJson, sendError, readBody } from '../lib/http.mjs';
import { subscribe } from '../lib/bus.mjs';
import {
  startCompatTask, listActiveTasks, projectState, exportProjectDocx, compatStepOf,
} from '../domain/tasks.mjs';
import { requireUser, projectIdOf, canAccessProject } from './_ctx.mjs';

const COMPAT_TYPES = [
  'bid-analysis',
  'outline-generation',
  'content-generation',
  'rejection-check',
  'duplicate-analysis',
  'global-facts-generation',
  'response-deviation-generation',
];

export function register(router) {
  router.add('GET', '/api/technical-plan', async ({ req, res, query }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const projectId = projectIdOf(req, query);
    sendJson(res, 200, { projectId, ...projectState(projectId) });
  });

  router.add('GET', '/api/tasks/active', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const projectId = projectIdOf(req);
    sendJson(res, 200, projectId ? listActiveTasks(projectId) : listActiveTasks(0));
  });

  for (const type of COMPAT_TYPES) {
    router.add('POST', `/api/tasks/start-${type}`, async ({ req, res }) => {
      const user = requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const projectId = projectIdOf(req, {}, body);
      const project = get('SELECT * FROM projects WHERE id=?', projectId);
      if (!project || !canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权操作该项目');
      if (!compatStepOf(type)) return sendError(res, 501, 'RUNNER_NOT_REGISTERED', `执行器尚未注册：${type}`);
      try {
        sendJson(res, 200, await startCompatTask(projectId, type, body, user));
      } catch (error) {
        sendError(res, 409, error.code || 'TASK_CONFLICT', String(error.message || error));
      }
    });
  }

  // 旧暂停接口：本实现里任务步骤是短事务，暂停语义仅做状态标记（保持接口可用）
  router.add('POST', '/api/tasks/pause-content-generation', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const projectId = projectIdOf(req);
    const running = get(
      "SELECT * FROM tasks WHERE project_id=? AND type='content-generation' AND status IN ('running','pausing') ORDER BY started_at DESC LIMIT 1",
      projectId,
    );
    if (!running) return sendError(res, 409, 'TASK_NOT_RUNNING', '当前没有正在执行的正文生成任务');
    run("UPDATE tasks SET status='paused', updated_at=? WHERE id=?", nowIso(), running.id);
    sendJson(res, 200, { success: true, task_id: running.id, status: 'paused' });
  });

  router.add('POST', '/api/export/docx', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const projectId = projectIdOf(req, {}, body);
    try {
      sendJson(res, 200, exportProjectDocx(projectId));
    } catch (error) {
      sendError(res, 400, 'EXPORT_FAILED', String(error.message));
    }
  });

  router.add('GET', '/api/events', async ({ req, res, query }) => {
    const user = requireUser(req, res, query);
    if (!user) return;
    const projectId = projectIdOf(req, query) || 0;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const unsubscribe = subscribe(projectId, res);
    const heartbeat = setInterval(() => { try { res.write(`: ping ${Date.now()}\n\n`); } catch { /* ignore */ } }, 25000);
    req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
  });

  // 静态文件（导出的 docx）
  router.add('GET', '/files/:name', async ({ res, params }) => {
    const name = path.basename(String(params.name || ''));
    const filePath = path.join(VAR_DIR, 'files', name);
    if (!filePath.startsWith(path.join(VAR_DIR, 'files')) || !fs.existsSync(filePath)) {
      return sendError(res, 404, 'FILE_NOT_FOUND', '文件不存在');
    }
    const buf = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(name)}"`,
    });
    res.end(buf);
  });

  // 健康检查
  router.add('GET', '/api/health', async ({ res }) => {
    sendJson(res, 200, { ok: true, time: nowIso(), sse: true });
  });
}
