// 质量配置 / 报告聚合 / 人工 override。
// 约定：GET 任意登录用户可读；PUT /api/quality/config 仅 admin（与 PUT /api/settings 一致）。
import { all, get, run, jparse, jstr } from '../db.mjs';
import { nowIso, clip } from '../lib/util.mjs';
import { sendJson, sendError, readBody } from '../lib/http.mjs';
import { publish } from '../lib/bus.mjs';
import { loadSettings } from '../seed.mjs';
import {
  publicQualityConfig, validateQualityConfigInput, buildQualityOverride, readOverride,
} from '../domain/quality.mjs';
import { requireUser, canAccessProject } from './_ctx.mjs';

/** 质量报告 → 前端视图：既保留 *_json 原始字段（兼容），也给 dimension/findings/judge 别名（新） */
function shapeReport(row, runRow = null) {
  const dimension = jparse(row.dimension_json, {});
  const findings = jparse(row.findings_json, []);
  const judge = jparse(row.judge_json, {});
  return {
    ...row,
    dimension_json: dimension,
    findings_json: findings,
    judge_json: judge,
    dimension,
    findings,
    judge,
    override: readOverride(judge),
    accepted_as_is: Boolean(readOverride(judge)),
    verdict: row.verdict,
    iteration: row.iteration,
    run_status: runRow?.status ?? null,
    project_id: runRow?.project_id ?? null,
    project_name: runRow ? (get('SELECT name FROM projects WHERE id=?', runRow.project_id)?.name ?? '') : '',
  };
}

function emitQualityEvent(runId, type, payload, actor = { type: 'system', id: null }) {
  const seq = Number(get('SELECT MAX(seq) AS m FROM events WHERE run_id=?', runId)?.m ?? 0) + 1;
  run('INSERT INTO events (run_id, seq, type, actor_type, actor_id, payload_json, created_at) VALUES (?,?,?,?,?,?,?)',
    runId, seq, type, actor.type, actor.id, jstr(payload), nowIso());
}

export function register(router) {
  // ---------- 配置 ----------
  router.add('GET', '/api/quality/config', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const settings = loadSettings();
    sendJson(res, 200, {
      ...publicQualityConfig(settings.quality),
      can_edit: user.role === 'admin',
      source: 'settings.quality',
    });
  });

  router.add('PUT', '/api/quality/config', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (user.role !== 'admin') return sendError(res, 403, 'ADMIN_ONLY', '仅管理员可修改质量配置');
    const body = await readBody(req);
    let normalized;
    try {
      normalized = validateQualityConfigInput(body);
    } catch (error) {
      return sendError(res, 400, 'QUALITY_CONFIG_INVALID', String(error.message).replace(/^QUALITY_CONFIG_INVALID:\s*/, ''));
    }
    const existing = loadSettings().quality || {};
    const thresholds = { ...(existing.thresholds || {}) };
    thresholds.pass = normalized.thresholds.pass;
    thresholds.revise = normalized.thresholds.revise;
    for (const key of ['duplicateSimilarity', 'minSectionWords', 'certWarnDays']) {
      if (body.thresholds && body.thresholds[key] !== undefined) thresholds[key] = normalized.thresholds[key];
    }
    const next = {
      ...existing,
      weights: normalized.weights,
      passScore: normalized.passScore,
      reviseScore: normalized.reviseScore,
      maxIterations: normalized.maxIterations,
      max_iterations: normalized.max_iterations,
      thresholds,
      judge: {
        ...(existing.judge || {}),
        ...(body.judge || {}),
        enabled: normalized.judge.enabled,
        two_pass: normalized.judge.two_pass,
        twoPass: normalized.judge.two_pass,
        model: body.judge?.model ?? existing.judge?.model ?? normalized.judge.model,
        cap_share: normalized.judge.cap_share,
      },
      veto: { ...(existing.veto || {}), cap: normalized.veto.cap },
    };
    run(`INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
      'quality', jstr(next), nowIso());
    sendJson(res, 200, { ok: true, config: publicQualityConfig(next) });
  });

  // ---------- 报告 ----------
  router.add('GET', '/api/quality/reports', async ({ req, res, query }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const runId = query.runId ? String(query.runId) : '';
    const nodeKey = query.nodeKey ? String(query.nodeKey) : '';
    const limit = Math.min(500, Math.max(1, Number(query.limit || 200)));
    let rows;
    if (runId) {
      const runRow = get('SELECT * FROM runs WHERE id=?', runId);
      if (!runRow) return sendError(res, 404, 'RUN_NOT_FOUND', '运行不存在');
      if (!canAccessProject(user, get('SELECT * FROM projects WHERE id=?', runRow.project_id))) {
        return sendError(res, 403, 'FORBIDDEN', '无权访问该运行');
      }
      rows = nodeKey
        ? all('SELECT * FROM quality_reports WHERE run_id=? AND node_key=? ORDER BY created_at ASC LIMIT ?', runId, nodeKey, limit)
        : all('SELECT * FROM quality_reports WHERE run_id=? ORDER BY created_at ASC LIMIT ?', runId, limit);
      sendJson(res, 200, rows.map((row) => shapeReport(row, runRow)));
      return;
    }
    rows = nodeKey
      ? all('SELECT * FROM quality_reports WHERE node_key=? ORDER BY created_at DESC LIMIT ?', nodeKey, limit)
      : all('SELECT * FROM quality_reports ORDER BY created_at DESC LIMIT ?', limit);
    const runCache = new Map();
    sendJson(res, 200, rows.map((row) => {
      if (!runCache.has(row.run_id)) runCache.set(row.run_id, get('SELECT * FROM runs WHERE id=?', row.run_id));
      return shapeReport(row, runCache.get(row.run_id));
    }));
  });

  // ---------- 人工 override：接受现状（不改分、不改判定，只留审计签字） ----------
  router.add('POST', '/api/runs/:id/quality/:reportId/override', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const runRow = get('SELECT * FROM runs WHERE id=?', params.id);
    if (!runRow) return sendError(res, 404, 'RUN_NOT_FOUND', '运行不存在');
    const project = get('SELECT * FROM projects WHERE id=?', runRow.project_id);
    if (!(user.role === 'admin' || project?.owner_id === user.id)) return sendError(res, 403, 'FORBIDDEN', '无权覆盖该质量报告');
    const report = get('SELECT * FROM quality_reports WHERE id=? AND run_id=?', params.reportId, params.id);
    if (!report) return sendError(res, 404, 'QUALITY_REPORT_NOT_FOUND', '质量报告不存在');
    const body = await readBody(req);
    const comment = String(body.comment ?? '').trim();
    if (comment.length < 1) return sendError(res, 400, 'REVIEW_COMMENT_TOO_SHORT', '请填写人工接受现状的理由');
    const judge = jparse(report.judge_json, {});
    const override = buildQualityOverride({ user, comment: clip(comment, 2000), report });
    const nextJudge = { ...judge, override, accepted_as_is: true, human_override: override };
    run('UPDATE quality_reports SET judge_json=? WHERE id=?', jstr(nextJudge), report.id);
    emitQualityEvent(runRow.id, 'quality.overridden', {
      report_id: report.id,
      node_key: report.node_key,
      iteration: report.iteration,
      total: report.total_score,
      verdict: report.verdict,
      accepted_as_is: true,
      comment: clip(comment, 300),
    }, { type: 'user', id: user.id });
    publish(runRow.project_id, 'quality', {
      type: 'quality.overridden', run_id: runRow.id, report_id: report.id,
      node_key: report.node_key, accepted_as_is: true,
    });
    sendJson(res, 200, {
      ok: true,
      report_id: report.id,
      run_id: runRow.id,
      node_key: report.node_key,
      accepted_as_is: true,
      override,
    });
  });
}
