// 技术方案工作区（对标 yibiao technical-plan/* + 项目工作台六步流水线）
//  · GET  /api/projects/:id/technical-plan          整棵状态（无数据时返回结构完整空态，不是 null）
//  · POST /api/projects/:id/technical-plan/steps    {step, options} → {task, state}
//  · POST /api/projects/:id/technical-plan/outline  {outline} 保存目录
//  · POST /api/projects/:id/technical-plan/content  {nodeId, markdown} 保存单章
//  · GET  /api/projects/:id/requirements[?veto=1]   解析条目
import { get } from '../db.mjs';
import { sendJson, sendError, readBody } from '../lib/http.mjs';
import { requireUser, canAccessProject } from './_ctx.mjs';
import {
  getTechnicalPlanView, startStep, saveOutline, saveChapter, listRequirements,
  getDeviation, patchDeviationRow, confirmDeviation, StepError,
} from '../domain/tasks.mjs';

function loadProject(req, res, params) {
  const user = requireUser(req, res);
  if (!user) return null;
  const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
  if (!project) {
    sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    return null;
  }
  if (!canAccessProject(user, project)) {
    sendError(res, 403, 'FORBIDDEN', '无权访问该项目');
    return null;
  }
  return { user, project };
}

export function register(router) {
  router.add('GET', '/api/projects/:id/technical-plan', async ({ req, res, params }) => {
    const ctx = loadProject(req, res, params);
    if (!ctx) return;
    sendJson(res, 200, getTechnicalPlanView(ctx.project.id));
  });

  router.add('POST', '/api/projects/:id/technical-plan/steps', async ({ req, res, params }) => {
    const ctx = loadProject(req, res, params);
    if (!ctx) return;
    const body = await readBody(req);
    const step = String(body.step ?? '');
    const options = body.options && typeof body.options === 'object' ? body.options : {};
    try {
      const result = await startStep(ctx.project.id, step, options, ctx.user);
      if (result.blocked) {
        sendJson(res, 409, {
          code: 'EXPORT_BLOCKED',
          error: `导出前置校验未通过：${(result.validation?.blockers || []).map((b) => b.label).join('、')}`,
          validation: result.validation,
          task: result.task,
          state: result.state,
        });
        return;
      }
      if (result.httpStatus && result.error) {
        sendJson(res, result.httpStatus, {
          code: result.error.code,
          error: result.error.message,
          task: result.task,
          state: result.state,
        });
        return;
      }
      sendJson(res, 200, {
        task: result.task,
        state: result.state,
        step: result.state?.step,
        deduped: Boolean(result.deduped),
      });
    } catch (error) {
      const status = error instanceof StepError ? error.status : 500;
      sendError(res, status, error instanceof StepError ? error.code : 'STEP_FAILED', String(error.message || error));
    }
  });

  router.add('POST', '/api/projects/:id/technical-plan/outline', async ({ req, res, params }) => {
    const ctx = loadProject(req, res, params);
    if (!ctx) return;
    const body = await readBody(req);
    const outline = body.outline ?? body.outlineData ?? body;
    try {
      const saved = saveOutline(ctx.project.id, outline);
      sendJson(res, 200, {
        outline: saved.outline,
        coverage: saved.outline.coverage,
        step: saved.steps,
      });
    } catch (error) {
      const status = error instanceof StepError ? error.status : 400;
      sendError(res, status, error instanceof StepError ? error.code : 'OUTLINE_INVALID', String(error.message || error));
    }
  });

  router.add('POST', '/api/projects/:id/technical-plan/content', async ({ req, res, params }) => {
    const ctx = loadProject(req, res, params);
    if (!ctx) return;
    const body = await readBody(req);
    const nodeId = body.nodeId ?? body.node_id ?? body.id;
    if (!nodeId) return sendError(res, 400, 'NODE_ID_REQUIRED', '缺少 nodeId');
    const markdown = body.markdown ?? body.content ?? body.text ?? '';
    try {
      const saved = saveChapter(ctx.project.id, nodeId, markdown);
      sendJson(res, 200, {
        node: saved.node,
        step: saved.step,
        content: {
          status: saved.content.status,
          total_words: saved.content.total_words,
          chapters: saved.content.chapters,
        },
      });
    } catch (error) {
      const status = error instanceof StepError ? error.status : 400;
      sendError(res, status, error instanceof StepError ? error.code : 'CHAPTER_SAVE_FAILED', String(error.message || error));
    }
  });

  router.add('GET', '/api/projects/:id/requirements', async ({ req, res, params, query }) => {
    const ctx = loadProject(req, res, params);
    if (!ctx) return;
    const vetoOnly = String(query?.veto ?? '') === '1' || query?.veto === 'true';
    const requirements = listRequirements(ctx.project.id, { veto: vetoOnly });
    const state = getTechnicalPlanView(ctx.project.id);
    sendJson(res, 200, {
      project_id: ctx.project.id,
      step: state.step,
      total: requirements.length,
      veto_count: requirements.filter((r) => r.veto).length,
      responded: requirements.filter((r) => r.responded).length,
      requirements,
    });
  });

  /* ── 响应偏离（人机协作：generate → 逐行编辑 → confirm → 才允许导出） ── */
  router.add('GET', '/api/projects/:id/deviation', async ({ req, res, params }) => {
    const ctx = loadProject(req, res, params);
    if (!ctx) return;
    const deviation = getDeviation(ctx.project.id);
    sendJson(res, 200, {
      project_id: ctx.project.id,
      status: deviation.status,
      confirmed: Boolean(deviation.confirmed),
      rows: deviation.rows || [],
      summary: deviation.summary || { total: (deviation.rows || []).length },
      generated_at: deviation.generated_at || null,
      confirmed_at: deviation.confirmed_at || null,
      confirmed_by: deviation.confirmed_by ?? null,
    });
  });

  router.add('POST', '/api/projects/:id/deviation/generate', async ({ req, res, params }) => {
    const ctx = loadProject(req, res, params);
    if (!ctx) return;
    try {
      const result = await startStep(ctx.project.id, 'deviation', {}, ctx.user);
      const deviation = result.state?.deviation || getDeviation(ctx.project.id);
      sendJson(res, 200, {
        project_id: ctx.project.id,
        task: result.task,
        status: deviation.status,
        confirmed: Boolean(deviation.confirmed),
        rows: deviation.rows || [],
        summary: deviation.summary || { total: (deviation.rows || []).length },
        generated_at: deviation.generated_at || null,
        deduped: Boolean(result.deduped),
      });
    } catch (error) {
      const status = error instanceof StepError ? error.status : 500;
      sendError(res, status, error instanceof StepError ? error.code : 'DEVIATION_FAILED', String(error.message || error));
    }
  });

  router.add('PATCH', '/api/projects/:id/deviation/rows/:rowId', async ({ req, res, params }) => {
    const ctx = loadProject(req, res, params);
    if (!ctx) return;
    const body = await readBody(req);
    try {
      const saved = patchDeviationRow(ctx.project.id, params.rowId, body);
      sendJson(res, 200, {
        project_id: ctx.project.id,
        row: saved.row,
        status: saved.deviation.status,
        confirmed: Boolean(saved.deviation.confirmed),
        summary: saved.deviation.summary,
      });
    } catch (error) {
      const status = error instanceof StepError ? error.status : 400;
      sendError(res, status, error instanceof StepError ? error.code : 'DEVIATION_ROW_INVALID', String(error.message || error));
    }
  });

  router.add('POST', '/api/projects/:id/deviation/confirm', async ({ req, res, params }) => {
    const ctx = loadProject(req, res, params);
    if (!ctx) return;
    try {
      const deviation = confirmDeviation(ctx.project.id, ctx.user);
      sendJson(res, 200, {
        project_id: ctx.project.id,
        status: deviation.status,
        confirmed: Boolean(deviation.confirmed),
        confirmed_at: deviation.confirmed_at,
        rows: deviation.rows || [],
        summary: deviation.summary,
      });
    } catch (error) {
      const status = error instanceof StepError ? error.status : 400;
      sendError(res, status, error instanceof StepError ? error.code : 'DEVIATION_CONFIRM_FAILED', String(error.message || error));
    }
  });
}
