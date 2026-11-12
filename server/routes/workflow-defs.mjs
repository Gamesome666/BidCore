// 流程模板域：/api/workflow-defs。
import { all, run, jparse, jstr } from '../db.mjs';
import { id, nowIso } from '../lib/util.mjs';
import { sendJson, sendError, readBody } from '../lib/http.mjs';
import { validatePlan, PlanInvalid } from '../domain/planner.mjs';
import { requireUser } from './_ctx.mjs';

export function register(router) {
  router.add('GET', '/api/workflow-defs', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    sendJson(res, 200, all('SELECT * FROM workflow_defs ORDER BY created_at DESC').map((d) => ({ ...d, graph_json: jparse(d.graph_json, null), policy_json: jparse(d.policy_json, {}) })));
  });

  router.add('POST', '/api/workflow-defs', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (user.role !== 'admin') return sendError(res, 403, 'ADMIN_ONLY', '仅管理员可修改流程模板');
    const body = await readBody(req);
    try {
      const graph = validatePlan(body.graph ?? body.graph_json);
      run('INSERT INTO workflow_defs (id, key, version, name, description, graph_json, policy_json, active, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
        id('wfd'), String(body.key || 'default'), Number(body.version || 1), String(body.name || '自定义流程'),
        String(body.description || ''), jstr(graph), jstr(body.policy || {}), 1, nowIso());
      sendJson(res, 201, { ok: true, graph });
    } catch (error) {
      sendError(res, 400, error instanceof PlanInvalid ? 'WF_PLAN_INVALID' : 'WF_PLAN_INVALID', String(error.message));
    }
  });
}
