// 项目域：/api/projects 增删改查 + /api/projects/:id/tender + /api/projects/:id/workspace。
// 工作台快照（workspace）是前端项目页的首屏聚合：项目 + 技术方案 state + 最近运行 + 待审 + 质量 + 检查 + 导出历史。
import { all, get, run, jparse } from '../db.mjs';
import { nowIso } from '../lib/util.mjs';
import { sendJson, sendError, readBody } from '../lib/http.mjs';
import { requireUser, canAccessProject } from './_ctx.mjs';
import { workspaceSnapshot } from '../domain/tasks.mjs';

function shapeProject(project, extra = {}) {
  if (!project) return null;
  return {
    ...project,
    tender_text: undefined,
    tender_chars: String(project.tender_text || '').length,
    tender_meta: jparse(project.tender_meta_json, {}),
    ...extra,
  };
}

export function register(router) {
  router.add('GET', '/api/projects', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const rows = user.role === 'admin'
      ? all('SELECT p.*, (SELECT COUNT(*) FROM runs r WHERE r.project_id=p.id) AS run_count FROM projects p ORDER BY p.created_at DESC')
      : all('SELECT p.*, (SELECT COUNT(*) FROM runs r WHERE r.project_id=p.id) AS run_count FROM projects p WHERE p.owner_id=? ORDER BY p.created_at DESC', user.id);
    sendJson(res, 200, rows.map((p) => shapeProject(p, {
      latest_run: get('SELECT id, status, started_at FROM runs WHERE project_id=? ORDER BY started_at DESC LIMIT 1', p.id),
    })));
  });

  router.add('POST', '/api/projects', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) return sendError(res, 400, 'PROJECT_NAME_REQUIRED', '项目名称必填');
    const code = String(body.code || `XM${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`);
    if (get('SELECT id FROM projects WHERE code=?', code)) return sendError(res, 409, 'PROJECT_CODE_TAKEN', `项目编号已存在：${code}`);
    const now = nowIso();
    const result = run(
      'INSERT INTO projects (code, name, bidder_name, description, status, owner_id, tender_text, tender_name, created_at, updated_at, deadline, budget, industry, tender_meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      code, name, String(body.bidderName || body.bidder_name || '智标科技有限公司'), String(body.description || ''),
      'active', user.id, String(body.tenderText || body.tender_text || ''), String(body.tenderName || body.tender_name || '招标文件.md'),
      now, now, body.deadline || null, body.budget || null, String(body.industry || ''),
      JSON.stringify(body.tenderMeta || {}),
    );
    sendJson(res, 201, get('SELECT * FROM projects WHERE id=?', Number(result.lastInsertRowid)));
  });

  router.add('GET', '/api/projects/:id', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权访问该项目');
    sendJson(res, 200, {
      ...shapeProject(project),
      runs: all('SELECT id, status, objective, started_at, plan_version FROM runs WHERE project_id=? ORDER BY started_at DESC LIMIT 10', project.id),
      owner: get('SELECT id, username, display_name FROM users WHERE id=?', project.owner_id),
    });
  });

  router.add('PUT', '/api/projects/:id', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project || !canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权修改该项目');
    const body = await readBody(req);
    run(
      'UPDATE projects SET name=?, bidder_name=?, description=?, status=?, tender_text=?, tender_name=?, deadline=?, budget=?, industry=?, updated_at=? WHERE id=?',
      body.name ?? project.name,
      body.bidderName ?? body.bidder_name ?? project.bidder_name,
      body.description ?? project.description,
      body.status ?? project.status,
      body.tenderText ?? body.tender_text ?? project.tender_text,
      body.tenderName ?? body.tender_name ?? project.tender_name,
      body.deadline ?? project.deadline,
      body.budget ?? project.budget,
      body.industry ?? project.industry,
      nowIso(),
      project.id,
    );
    sendJson(res, 200, get('SELECT * FROM projects WHERE id=?', project.id));
  });

  router.add('GET', '/api/projects/:id/tender', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project || !canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权访问');
    sendJson(res, 200, { name: project.tender_name, text: project.tender_text });
  });

  // 项目工作台快照：state 为 project_state.data_json 的解析结果
  router.add('GET', '/api/projects/:id/workspace', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权访问该项目');

    const snapshot = workspaceSnapshot(project.id);
    sendJson(res, 200, {
      project: shapeProject(project, {
        owner: get('SELECT id, username, display_name FROM users WHERE id=?', project.owner_id),
      }),
      state: snapshot.state,
      latest_run: snapshot.latest_run,
      pending_reviews: snapshot.pending_reviews,
      quality: snapshot.quality,
      checks: snapshot.checks,
      exports: snapshot.exports,
    });
  });
}
