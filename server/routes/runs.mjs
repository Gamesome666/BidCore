// 运行域：/api/runs*、命令、事件、产物、版本对比、质量报告。
import { all, get, run, jparse, jstr } from '../db.mjs';
import { id, nowIso } from '../lib/util.mjs';
import { sendJson, sendError, readBody } from '../lib/http.mjs';
import { engine } from '../domain/engine.mjs';
import { diffPayload } from '../domain/diff.mjs';
import { requireUser, canAccessProject } from './_ctx.mjs';

export function register(router) {
  router.add('POST', '/api/runs', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const projectId = Number(body.projectId);
    const project = get('SELECT * FROM projects WHERE id=?', projectId);
    if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权在该项目启动工作流');
    try {
      const runRow = await engine.createRun({
        projectId, user,
        objective: body.objective || `为「${project.name}」生成投标文件`,
        mode: body.mode || 'auto', dryRun: Boolean(body.dryRun),
      });
      sendJson(res, 201, { run_id: runRow.id, status: runRow.status });
    } catch (error) {
      sendError(res, 500, 'WF_START_FAILED', String(error.message));
    }
  });

  router.add('GET', '/api/runs', async ({ req, res, query }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const projectId = Number(query.projectId || 0);
    const rows = projectId
      ? all('SELECT * FROM runs WHERE project_id=? ORDER BY started_at DESC LIMIT 50', projectId)
      : all('SELECT * FROM runs ORDER BY started_at DESC LIMIT 50');
    sendJson(res, 200, rows.map((r) => ({
      ...r, plan_json: undefined, context_json: undefined,
      project_name: get('SELECT name FROM projects WHERE id=?', r.project_id)?.name ?? '',
      node_count: get('SELECT COUNT(*) AS c FROM node_runs WHERE run_id=?', r.id)?.c ?? 0,
      waiting: get("SELECT COUNT(*) AS c FROM node_runs WHERE run_id=? AND status='waiting_human'", r.id)?.c ?? 0,
    })));
  });

  router.add('GET', '/api/runs/:id', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const snap = engine.snapshot(params.id);
    if (!snap) return sendError(res, 404, 'RUN_NOT_FOUND', '运行不存在');
    if (!canAccessProject(user, get('SELECT * FROM projects WHERE id=?', snap.run.project_id))) return sendError(res, 403, 'FORBIDDEN', '无权访问');
    sendJson(res, 200, snap);
  });

  router.add('POST', '/api/runs/:id/commands', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const runRow = get('SELECT * FROM runs WHERE id=?', params.id);
    if (!runRow) return sendError(res, 404, 'RUN_NOT_FOUND', '运行不存在');
    const project = get('SELECT * FROM projects WHERE id=?', runRow.project_id);
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权操作');
    const body = await readBody(req);
    const type = String(body.type || '');
    const commandId = String(body.commandId || id('cmd'));
    const existing = get('SELECT * FROM commands WHERE run_id=? AND command_id=?', params.id, commandId);
    if (existing) return sendJson(res, 200, jparse(existing.result_json, { success: true }));

    try {
      let result = { success: true, type };
      if (type === 'pause') engine.pause(params.id, user.id);
      else if (type === 'resume') engine.resume(params.id, user.id);
      else if (type === 'cancel') engine.cancel(params.id, user.id);
      else if (type === 'reconcile') {
        const reconciled = engine.reconcile(params.id, { force: true });
        // 契约（规格 §B9）：interrupted/recovered/waiting 均为 nodeKey 数组
        result = {
          success: true,
          interrupted: reconciled.interrupted,
          interrupted_count: reconciled.interrupted.length,
          interrupted_nodes: reconciled.interrupted,
          recovered: reconciled.recovered,
          waiting: reconciled.waiting,
          run_status: get('SELECT status FROM runs WHERE id=?', params.id)?.status ?? 'running',
        };
      } else if (type === 'retry-node') engine.retryNode(params.id, String(body.nodeKey || ''), user.id);
      else if (type === 'skip-node') {
        result = { success: true, ...engine.skipNode(params.id, String(body.nodeKey || ''), user.id) };
      } else return sendError(res, 400, 'UNKNOWN_COMMAND', `未知命令：${type}`);
      run('INSERT INTO commands (id, run_id, command_id, type, payload_json, status, result_json, created_at) VALUES (?,?,?,?,?,?,?,?)',
        id('cmd'), params.id, commandId, type, jstr(body), 'applied', jstr(result), nowIso());
      sendJson(res, 200, result);
    } catch (error) {
      sendError(res, 409, error.code || 'COMMAND_FAILED', String(error.message));
    }
  });

  // 人工跳过节点：命令幂等（commandId）+ 仅允许显式可跳状态；下游由 promoteReady 正常推进
  router.add('POST', '/api/runs/:id/nodes/:nodeKey/skip', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const runRow = get('SELECT * FROM runs WHERE id=?', params.id);
    if (!runRow) return sendError(res, 404, 'RUN_NOT_FOUND', '运行不存在');
    const project = get('SELECT * FROM projects WHERE id=?', runRow.project_id);
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权操作');
    const body = await readBody(req);
    const commandId = body.commandId ? String(body.commandId) : '';
    if (commandId) {
      const existing = get('SELECT * FROM commands WHERE run_id=? AND command_id=?', params.id, commandId);
      if (existing) return sendJson(res, 200, jparse(existing.result_json, { ok: true }));
    }
    try {
      const result = engine.skipNode(params.id, params.nodeKey, user.id);
      const payload = { success: true, command_id: commandId || null, ...result };
      if (commandId) {
        run('INSERT INTO commands (id, run_id, command_id, type, payload_json, status, result_json, created_at) VALUES (?,?,?,?,?,?,?,?)',
          id('cmd'), params.id, commandId, 'node-skip', jstr({ nodeKey: params.nodeKey }), 'applied', jstr(payload), nowIso());
      }
      sendJson(res, 200, payload);
    } catch (error) {
      const code = error.code || 'WF_NODE_SKIP_FAILED';
      const status = code === 'WF_NODE_NOT_FOUND' ? 404 : 409;
      sendError(res, status, code, String(error.message));
    }
  });

  // Supervisor 可观测视图：计划 + 预算 + 决策流水 + 并行批次
  router.add('GET', '/api/runs/:id/supervisor', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const runRow = get('SELECT * FROM runs WHERE id=?', params.id);
    if (!runRow) return sendError(res, 404, 'RUN_NOT_FOUND', '运行不存在');
    const project = get('SELECT * FROM projects WHERE id=?', runRow.project_id);
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权访问');
    const view = engine.supervisor(params.id);
    if (!view) return sendError(res, 404, 'RUN_NOT_FOUND', '运行不存在');
    sendJson(res, 200, view);
  });

  router.add('GET', '/api/runs/:id/events', async ({ req, res, params, query }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const after = Number(query.afterSeq || 0);
    const rows = all('SELECT * FROM events WHERE run_id=? AND seq>? ORDER BY seq ASC LIMIT 500', params.id, after);
    sendJson(res, 200, rows.map((e) => ({ ...e, payload_json: jparse(e.payload_json, {}) })));
  });

  router.add('GET', '/api/runs/:id/artifacts', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    sendJson(res, 200, all('SELECT id, kind, version, status, sha256, summary, created_at FROM artifacts WHERE run_id=? ORDER BY kind, version DESC', params.id));
  });

  router.add('GET', '/api/runs/:id/artifacts/:kind', async ({ req, res, params, query }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const kind = `${params.kind}${query.sub ? `:${query.sub}` : ''}`;
    const rows = all('SELECT * FROM artifacts WHERE run_id=? AND kind=? ORDER BY version DESC', params.id, kind);
    if (!rows.length) return sendError(res, 404, 'ARTIFACT_NOT_FOUND', '产物不存在');
    sendJson(res, 200, rows.map((r) => ({ ...r, payload_json: jparse(r.payload_json, null), provenance_json: jparse(r.provenance_json, {}) })));
  });

  router.add('GET', '/api/runs/:id/diff', async ({ req, res, params, query }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const kind = String(query.kind || '');
    const rows = all('SELECT * FROM artifacts WHERE run_id=? AND kind=? ORDER BY version ASC', params.id, kind);
    const from = rows.find((r) => r.version === Number(query.from)) ?? rows.at(-2);
    const to = rows.find((r) => r.version === Number(query.to)) ?? rows.at(-1);
    if (!from || !to) return sendError(res, 404, 'DIFF_NOT_AVAILABLE', '版本不足，无法对比');
    sendJson(res, 200, { kind, from: from.version, to: to.version, ...diffPayload(jparse(from.payload_json, null), jparse(to.payload_json, null)) });
  });

  router.add('GET', '/api/runs/:id/quality', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const rows = all('SELECT * FROM quality_reports WHERE run_id=? ORDER BY created_at ASC', params.id);
    sendJson(res, 200, rows.map((q) => ({
      ...q,
      dimension_json: jparse(q.dimension_json, {}),
      findings_json: jparse(q.findings_json, []),
      judge_json: jparse(q.judge_json, {}),
    })));
  });
}
