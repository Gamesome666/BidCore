// 仪表盘聚合接口 /api/dashboard
// 对标 yibiao DashboardPage：项目统计 + 待办审核 + 质量均分/通过率/趋势 + 最近运行。
// 口径：非 admin 只看自己作为 owner 的项目，避免越权看到别人项目的运行与质量数据。
import { all, get } from '../db.mjs';
import { nowIso } from '../lib/util.mjs';
import { sendJson } from '../lib/http.mjs';
import { requireUser } from './_ctx.mjs';

const RUNNING = new Set(['planning', 'running', 'replanning', 'paused']);
const WAITING = new Set(['waiting_human']);

function inList(ids) {
  return ids.map(() => '?').join(',');
}

export function register(router) {
  router.add('GET', '/api/dashboard', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;

    const projects = user.role === 'admin'
      ? all('SELECT id, name, status FROM projects ORDER BY created_at DESC')
      : all('SELECT id, name, status FROM projects WHERE owner_id=? ORDER BY created_at DESC', user.id);
    const ids = projects.map((p) => p.id);
    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    const now = nowIso();

    if (!ids.length) {
      sendJson(res, 200, {
        projects: { total: 0, active: 0 },
        runs: { running: 0, waiting: 0, completed: 0, avg_minutes: 0 },
        reviews: { mine: 0, pending: 0, overdue: 0 },
        quality: { avg: 0, pass_rate: 0, trend: [] },
        recent_runs: [],
        pending_reviews: [],
      });
      return;
    }

    const list = inList(ids);
    const runs = all(`SELECT id, project_id, status, started_at, finished_at FROM runs WHERE project_id IN (${list})`, ...ids);
    const nodeCounts = new Map();
    if (runs.length) {
      for (const row of all(
        `SELECT run_id, COUNT(*) AS total, SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS done
           FROM node_runs WHERE run_id IN (SELECT id FROM runs WHERE project_id IN (${list})) GROUP BY run_id`,
        ...ids,
      )) {
        nodeCounts.set(row.run_id, { total: Number(row.total || 0), done: Number(row.done || 0) });
      }
    }

    const qualityRows = all(
      `SELECT total_score, verdict, created_at FROM quality_reports
        WHERE run_id IN (SELECT id FROM runs WHERE project_id IN (${list}))
        ORDER BY created_at ASC`,
      ...ids,
    );
    const scores = qualityRows.map((q) => q.total_score);
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    const passCount = qualityRows.filter((q) => q.verdict === 'pass').length;
    const passRate = qualityRows.length ? Number((passCount / qualityRows.length).toFixed(3)) : 0;
    const trend = qualityRows.slice(-12).map((q) => ({ at: q.created_at, score: q.total_score }));

    const pendingRows = all(
      `SELECT * FROM review_tasks WHERE project_id IN (${list}) AND status='pending' ORDER BY sla_due_at ASC`,
      ...ids,
    );

    const completedRuns = runs.filter((r) => r.status === 'completed' && r.finished_at && r.started_at);
    const avgMinutes = completedRuns.length
      ? Number((
        completedRuns.reduce((sum, r) => sum + (new Date(r.finished_at).getTime() - new Date(r.started_at).getTime()), 0)
        / completedRuns.length / 60000
      ).toFixed(1))
      : 0;

    const recentRuns = runs
      .slice()
      .sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)))
      .slice(0, 8)
      .map((r) => {
        const counts = nodeCounts.get(r.id) || { total: 0, done: 0 };
        return {
          id: r.id,
          project_name: projectName.get(r.project_id) || '',
          status: r.status,
          started_at: r.started_at,
          node_done: counts.done,
          node_total: counts.total,
        };
      });

    const pendingReviews = pendingRows.slice(0, 8).map((row) => ({
      id: row.id,
      project_name: projectName.get(row.project_id) || '',
      gate_key: row.gate_key,
      level: row.level,
      level_total: row.level_total,
      sla_due_at: row.sla_due_at,
      overdue: row.sla_due_at < now,
    }));

    sendJson(res, 200, {
      projects: {
        total: projects.length,
        active: projects.filter((p) => p.status === 'active').length,
      },
      runs: {
        running: runs.filter((r) => RUNNING.has(r.status)).length,
        waiting: runs.filter((r) => WAITING.has(r.status)).length,
        completed: runs.filter((r) => r.status === 'completed').length,
        avg_minutes: avgMinutes,
      },
      reviews: {
        mine: pendingRows.filter((row) => row.assignee_id === user.id).length,
        pending: pendingRows.length,
        overdue: pendingRows.filter((row) => row.sla_due_at < now).length,
      },
      quality: { avg, pass_rate: passRate, trend },
      recent_runs: recentRuns,
      pending_reviews: pendingReviews,
    });
  });

  // 轻量健康视图：给顶栏/首页做链路自检（不参与契约，纯附加）
  router.add('GET', '/api/dashboard/health', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const counts = {
      projects: get('SELECT COUNT(*) AS c FROM projects')?.c ?? 0,
      runs: get('SELECT COUNT(*) AS c FROM runs')?.c ?? 0,
      pending_reviews: get("SELECT COUNT(*) AS c FROM review_tasks WHERE status='pending'")?.c ?? 0,
      open_tasks: get("SELECT COUNT(*) AS c FROM tasks WHERE status IN ('running','pausing')")?.c ?? 0,
      exports: get('SELECT COUNT(*) AS c FROM exports')?.c ?? 0,
    };
    sendJson(res, 200, { ok: true, time: nowIso(), counts });
  });
}
