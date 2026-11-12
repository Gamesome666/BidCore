// 标书检查：废标项 / 查重
//  · GET  /api/projects/:id/checks              读结果（空态结构完整）
//  · POST /api/projects/:id/checks/:kind/run    kind=rejection|duplicate，跑完返回 task + checks
import { get } from '../db.mjs';
import { sendJson, sendError } from '../lib/http.mjs';
import { requireUser, canAccessProject } from './_ctx.mjs';
import { getTechnicalPlanView, startStep, StepError } from '../domain/tasks.mjs';

export function register(router) {
  router.add('GET', '/api/projects/:id/checks', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权访问该项目');
    const view = getTechnicalPlanView(project.id);
    sendJson(res, 200, {
      project_id: project.id,
      step: view.step,
      rejection: view.checks.rejection,
      duplicate: view.checks.duplicate,
      export_ready: Boolean(view.export?.validation?.ok),
    });
  });

  router.add('POST', '/api/projects/:id/checks/:kind/run', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const kind = String(params.kind || '');
    if (!['rejection', 'duplicate'].includes(kind)) {
      return sendError(res, 400, 'CHECK_KIND_INVALID', `未知检查类型：${kind}（可选 rejection|duplicate）`);
    }
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权访问该项目');

    try {
      const result = await startStep(
        project.id,
        'checks',
        { kinds: [kind] },
        user,
        { taskType: kind === 'rejection' ? 'rejection-check' : 'duplicate-analysis' },
      );
      sendJson(res, 200, {
        project_id: project.id,
        kind,
        task: result.task,
        step: result.state?.step,
        rejection: result.state?.checks?.rejection,
        duplicate: result.state?.checks?.duplicate,
        deduped: Boolean(result.deduped),
      });
    } catch (error) {
      const status = error instanceof StepError ? error.status : 500;
      sendError(res, status, error instanceof StepError ? error.code : 'CHECK_FAILED', String(error.message || error));
    }
  });
}
