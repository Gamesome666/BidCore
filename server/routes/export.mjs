// 导出（Word）+ 导出历史 + 前置校验
//  · POST /api/projects/:id/export     前置校验（废标未响应/偏离未确认/正文缺失/占位符）不通过 → 409 EXPORT_BLOCKED
//  · GET  /api/projects/:id/exports    历史数组（含 download_url）
// Word 由 domain/docx.mjs 现场写 OOXML 到 var/files/，下载走既有的 /files/:name。
import { get } from '../db.mjs';
import { sendJson, sendError, readBody } from '../lib/http.mjs';
import { requireUser, canAccessProject } from './_ctx.mjs';
import { listExports, startStep, createProjectExport, StepError } from '../domain/tasks.mjs';

export function register(router) {
  router.add('POST', '/api/projects/:id/export', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权访问该项目');
    const body = await readBody(req); // {force?} 目前不影响校验：阻断项必须真的修掉

    let result;
    try {
      result = await startStep(project.id, 'export', { ...(body || {}) }, user, { taskType: 'export-word' });
    } catch (error) {
      const status = error instanceof StepError ? error.status : 500;
      sendError(res, status, error instanceof StepError ? error.code : 'EXPORT_FAILED', String(error.message || error));
      return;
    }

    if (result.blocked) {
      const blockers = result.validation?.blockers || [];
      sendJson(res, 409, {
        code: 'EXPORT_BLOCKED',
        error: `导出前置校验未通过：${blockers.map((b) => b.label).join('、') || '存在未通过项'}`,
        validation: result.validation,
        task: result.task,
      });
      return;
    }

    let record = result.record;
    if (!record) {
      // 兜底：任务链路异常时直接走同步导出，保证接口可用
      const direct = createProjectExport(project.id, user);
      if (!direct.ok) {
        sendJson(res, 409, {
          code: 'EXPORT_BLOCKED',
          error: `导出前置校验未通过：${(direct.validation.blockers || []).map((b) => b.label).join('、')}`,
          validation: direct.validation,
        });
        return;
      }
      record = direct.record;
    }

    sendJson(res, 200, {
      id: record.id,
      file: record.file,
      download_url: record.download_url,
      bytes: record.bytes,
      sha256: record.sha256,
      validation: record.validation,
      created_at: record.created_at,
      task: result.task,
    });
  });

  router.add('GET', '/api/projects/:id/exports', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权访问该项目');
    sendJson(res, 200, listExports(project.id));
  });
}
