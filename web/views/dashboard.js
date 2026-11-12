// 工作台总览：4 KPI + 待办审核 / 最近运行 + 质量趋势 / 能力雷达 / 工作流说明。
// 数据源：/api/dashboard（聚合）；异常时降级到 projects + runs + reviews + quality 实时聚合。
import { api } from '../lib/api.js';
import {
  escapeHtml, fmtDate, fmtDateTime, fmtRelative, statusPill, verdictPill, pill,
  sparkline, radar, scoreRing, barRow, dimLabel, toast, emptyState, skeletonRows,
} from '../lib/ui.js';

const STYLE = `
<style>
  .dash-head { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
  .dash-eyebrow { font-size: 10.5px; letter-spacing: .2em; text-transform: uppercase; color: var(--accent); font-weight: 700; margin-bottom: 4px; }
  .dash-title { font-family: var(--serif); font-size: 29px; line-height: 1.22; color: var(--ink); font-weight: 600; }
  .dash-title em { font-style: normal; color: var(--accent); }
  .dash-desc { font-size: 12.5px; color: var(--muted); margin-top: 6px; max-width: 780px; }
  .dash-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .dash-kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin-bottom: 14px; }
  .dash-newdot { display: inline-block; width: 7px; height: 7px; border-radius: 99px; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); vertical-align: 1px; margin-left: 3px; }
  .dash-banner { display: flex; align-items: flex-start; gap: 9px; border: 1px solid var(--line); background: var(--card-2); border-radius: var(--radius); padding: 9px 12px; font-size: 11.8px; color: var(--ink-3); margin-bottom: 12px; }
  .dash-banner i { font-style: normal; color: var(--accent); }
  .dash-guide { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 12px; }
  .dash-guide-step { border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 15px; background: var(--card-2); }
  .dash-guide-step .g-no { font-family: var(--serif); font-size: 21px; color: var(--accent); line-height: 1; }
  .dash-guide-step .g-title { font-size: 13px; font-weight: 650; color: var(--ink); margin-top: 7px; }
  .dash-guide-step .g-body { font-size: 11.8px; color: var(--muted); margin-top: 4px; line-height: 1.65; }
  .dash-flow { display: flex; flex-direction: column; }
  .dash-flow-row { display: flex; gap: 10px; padding: 9px 0; border-bottom: 1px dashed var(--line); }
  .dash-flow-row:last-child { border-bottom: 0; padding-bottom: 0; }
  .dash-flow-row .no { font-family: var(--mono); font-size: 10.5px; color: var(--accent); padding-top: 2px; letter-spacing: .06em; }
  .dash-flow-row .t { font-size: 12.4px; color: var(--ink); font-weight: 600; }
  .dash-flow-row .d { font-size: 11.4px; color: var(--muted); margin-top: 1px; line-height: 1.6; }
  .dash-metric { display: flex; align-items: baseline; gap: 8px; }
  .dash-metric .big { font-family: var(--serif); font-size: 30px; color: var(--ink); font-variant-numeric: tabular-nums; line-height: 1.1; }
  .dash-run-meta { font-size: 11.5px; color: var(--muted); }
  @media (max-width: 1280px) { .dash-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .dash-guide { grid-template-columns: 1fr; } }
  @media (max-width: 720px) { .dash-kpis { grid-template-columns: 1fr; } }
</style>`;

const WORKFLOW_NOTES = [
  ['01', 'Supervisor 规划', '读招标文件与知识库，产出节点计划、依赖、并行度与预算上限。'],
  ['02', 'Agent 执行', '解析、检索、策略、技术、商务、合规分头执行；任务带租赁锁，失败可重试。'],
  ['03', '质量门禁', '规则轨 + 受限评委给出五维分与追责证据；低于阈值触发定向返工。'],
  ['04', '人工审核', '多级门禁逐级签署；驳回必须指向上游 Agent，修改留痕可对比版本。'],
];

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 11) return '早上好';
  if (hour < 13) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

function shortName(user) {
  return String(user?.display_name || user?.username || '').split('·')[0].trim() || '同事';
}

function minutesLeft(review) {
  if (Number.isFinite(Number(review.minutes_left))) return Number(review.minutes_left);
  const due = new Date(review.sla_due_at).getTime();
  if (Number.isNaN(due)) return Number.NaN;
  return Math.round((due - Date.now()) / 60000);
}

/** quality_reports（/api/quality/reports）→ 雷达维度与最近一份报告 */
async function loadQualityExtras() {
  try {
    const reports = await api.qualityReports();
    const list = Array.isArray(reports) ? reports : [];
    const latest = list[0] || null; // 接口按 created_at DESC
    const dimensions = latest?.dimension || latest?.dimension_json || null;
    return {
      dimensions: dimensions && Object.keys(dimensions).length ? dimensions : null,
      latest: latest
        ? {
          total_score: latest.total_score,
          verdict: latest.verdict,
          node_key: latest.node_key,
          iteration: latest.iteration,
          created_at: latest.created_at,
        }
        : null,
    };
  } catch {
    return { dimensions: null, latest: null };
  }
}

function shapeEmpty() {
  return {
    source: 'api',
    notice: '',
    projectTotal: 0,
    activeProjects: 0,
    runningRuns: 0,
    waitingRuns: 0,
    completedRuns: 0,
    avgMinutes: null,
    recentRuns: [],
    pendingReviews: [],
    summary: { mine: 0, all: 0, overdue: 0 },
    quality: { scores: [], avg: null, passRate: null, sample: 0, dimensions: null, latest: null },
  };
}

async function loadDashboard() {
  let notice = '';
  try {
    const raw = await api.dashboard();
    if (raw && typeof raw === 'object') {
      const extras = await loadQualityExtras();
      return normalizeDashboard(raw, extras);
    }
  } catch (error) {
    notice = error?.status === 404
      ? '聚合接口 /api/dashboard 尚未实现，已用「项目 / 运行 / 审核 / 质量」接口实时聚合。'
      : `聚合接口异常（${error?.message || String(error)}），已降级为实时聚合。`;
  }

  const [projects, runs, summary, pending, extras] = await Promise.all([
    api.projects(),
    api.runs(),
    api.reviewSummary().catch(() => ({ mine: 0, all: 0, overdue: 0 })),
    api.reviews({ status: 'pending' }).catch(() => []),
    loadQualityExtras(),
  ]);
  const recentRuns = runs.slice(0, 8).map((run) => ({
    id: run.id,
    project_name: run.project_name || '',
    status: run.status,
    started_at: run.started_at,
    node_done: run.node_done ?? null,
    node_total: run.node_count ?? null,
  }));
  const scores = (extras.latest ? [] : []).concat([]);
  const qualityRows = await Promise.all(recentRuns.slice(0, 5).map((run) => api.quality(run.id).catch(() => [])));
  const flat = qualityRows.flat().filter((row) => row && Number.isFinite(Number(row.total_score)));
  for (const row of flat) scores.push(Number(row.total_score));
  const passCount = flat.filter((row) => row.verdict === 'pass').length;
  return {
    ...shapeEmpty(),
    source: 'aggregate',
    notice,
    projectTotal: projects.length,
    activeProjects: projects.filter((item) => item.status !== 'archived').length,
    runningRuns: runs.filter((run) => ['planning', 'running', 'replanning', 'paused'].includes(run.status)).length,
    waitingRuns: runs.filter((run) => run.status === 'waiting_human').length,
    completedRuns: runs.filter((run) => run.status === 'completed').length,
    recentRuns,
    pendingReviews: pending,
    summary: { mine: summary.mine || 0, all: summary.all ?? pending.length, overdue: summary.overdue || 0 },
    quality: {
      scores,
      avg: scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length) : null,
      passRate: flat.length ? Math.round((passCount / flat.length) * 100) : null,
      sample: scores.length,
      dimensions: extras.dimensions,
      latest: extras.latest,
    },
  };
}

function normalizeDashboard(raw, extras = {}) {
  const projectsBlock = raw.projects && !Array.isArray(raw.projects) ? raw.projects : null;
  const runsBlock = raw.runs || {};
  const reviewsBlock = raw.reviews || {};
  const qualityBlock = raw.quality || {};
  const pending = raw.pending_reviews || raw.pendingReviews || [];
  const trend = Array.isArray(qualityBlock.trend) ? qualityBlock.trend : [];
  const scores = trend
    .map((item) => (typeof item === 'number' ? item : Number(item?.score)))
    .filter((value) => Number.isFinite(value));
  const passRateRaw = qualityBlock.pass_rate ?? qualityBlock.passRate ?? null;
  const passRate = passRateRaw === null
    ? null
    : Math.round(Number(passRateRaw) <= 1 ? Number(passRateRaw) * 100 : Number(passRateRaw));
  return {
    ...shapeEmpty(),
    source: 'api',
    projectTotal: projectsBlock?.total ?? raw.project_total ?? 0,
    activeProjects: projectsBlock?.active ?? raw.active_projects ?? 0,
    runningRuns: runsBlock.running ?? raw.running_runs ?? 0,
    waitingRuns: runsBlock.waiting ?? raw.waiting_runs ?? 0,
    completedRuns: runsBlock.completed ?? 0,
    avgMinutes: runsBlock.avg_minutes ?? null,
    recentRuns: raw.recent_runs || raw.recentRuns || [],
    pendingReviews: pending,
    summary: {
      mine: reviewsBlock.mine ?? 0,
      all: reviewsBlock.pending ?? pending.length,
      overdue: reviewsBlock.overdue ?? 0,
    },
    quality: {
      scores,
      avg: qualityBlock.avg ?? null,
      passRate,
      sample: scores.length,
      dimensions: extras.dimensions || qualityBlock.dimensions || null,
      latest: extras.latest || qualityBlock.latest || null,
    },
  };
}

export default {
  title: '总览',
  async render(root, ctx) {
    let data = null;
    let timer = null;

    function headMarkup() {
      return `<div class="dash-head">
        <div>
          <div class="dash-eyebrow">工作台总览</div>
          <h1 class="dash-title">${escapeHtml(greeting())}，<em>${escapeHtml(shortName(ctx.user))}</em></h1>
          <p class="dash-desc">${escapeHtml(fmtDate(new Date().toISOString()))} · 先看待办审核，再决定是否启动新一轮工作流。</p>
        </div>
        <div class="dash-actions">
          <button class="btn" id="dash-new">＋ 新建项目</button>
          <button class="btn primary" id="dash-run">▶ 启动工作流</button>
        </div>
      </div>`;
    }

    function kpis() {
      // 管理员可处理全部待办，KPI 直接展示全量；其他角色只看指派给自己的
      const isAdmin = ctx.user?.role === 'admin';
      const mine = Number(isAdmin ? (data.summary.all ?? data.summary.mine ?? 0) : (data.summary.mine || 0));
      return `<div class="dash-kpis">
        <div class="kpi">
          <div class="k-label">进行中项目</div>
          <div class="k-value">${data.activeProjects}<small>个</small></div>
          <div class="k-foot">共 ${data.projectTotal} 个项目 · 已完成运行 ${data.completedRuns} 条</div>
        </div>
        <div class="kpi">
          <div class="k-label">运行中任务</div>
          <div class="k-value">${data.runningRuns}<small>条</small></div>
          <div class="k-foot">等待人工 ${data.waitingRuns} · 平均耗时 ${data.avgMinutes === null || data.avgMinutes === undefined ? '—' : `${data.avgMinutes} 分钟`}</div>
        </div>
        <div class="kpi accent">
          <div class="k-label">待我审核 ${mine ? '<i class="dash-newdot"></i>' : ''}</div>
          <div class="k-value" style="color:${mine ? 'var(--accent)' : 'inherit'}">${mine}<small>项</small></div>
          <div class="k-foot">全部待审 ${data.summary.all} · 超时 ${data.summary.overdue}</div>
        </div>
        <div class="kpi jade">
          <div class="k-label">质量均分</div>
          <div class="k-value">${data.quality.avg === null || data.quality.avg === undefined ? '—' : data.quality.avg}<small>分</small></div>
          <div class="k-foot">达标率 ${data.quality.passRate === null || data.quality.passRate === undefined ? '—' : `${data.quality.passRate}%`} · 阈值 80 · 样本 ${data.quality.sample}</div>
        </div>
      </div>`;
    }

    function reviewRows() {
      const list = data.pendingReviews || [];
      if (!list.length) return emptyState('没有待办审核', '命中人工门禁的产物会出现在这里', '✓');
      const mineId = ctx.user?.id;
      return `<div class="list">${list.slice(0, 6).map((review) => {
        const mine = review.assignee_id && review.assignee_id === mineId;
        const minutes = minutesLeft(review);
        const late = review.overdue || minutes < 0;
        return `<div class="list-row pointer" data-review="${escapeHtml(review.id)}">
          <div class="l-main">
            <div class="l-title">${escapeHtml(review.agent_label || review.gate_key || '审核门禁')}
              ${mine ? '<span class="pill accent">我的</span>' : ''}</div>
            <div class="l-sub">
              <span>${escapeHtml(review.project_name || '')}</span>
              <span>第 ${review.level}/${review.level_total} 级</span>
              ${review.sla_due_at ? `<span>${escapeHtml(fmtRelative(review.sla_due_at))}到期</span>` : ''}
            </div>
          </div>
          ${pill(late ? '已超时' : Number.isFinite(minutes) ? `剩 ${Math.max(0, Math.round(minutes))} 分钟` : '待处理', late ? 'bad' : Number.isFinite(minutes) && minutes < 60 ? 'warn' : 'plain')}
        </div>`;
      }).join('')}</div>`;
    }

    function runRows() {
      const list = data.recentRuns || [];
      if (!list.length) return emptyState('还没有运行记录', '在右上角「启动工作流」让 Supervisor 先出计划', '⌗');
      return `<div class="table-wrap"><table class="table compact">
        <thead><tr><th>运行</th><th>项目</th><th>状态</th><th class="num">节点</th><th>开始</th></tr></thead>
        <tbody>${list.slice(0, 6).map((run) => `<tr class="clickable" data-run="${escapeHtml(String(run.id || ''))}">
          <td class="mono fs11">${escapeHtml(String(run.id || '').slice(0, 12))}</td>
          <td class="ellipsis" style="max-width:220px">${escapeHtml(run.project_name || '')}</td>
          <td>${statusPill(run.status)}</td>
          <td class="num">${run.node_done ?? '—'}/${run.node_total ?? '—'}</td>
          <td class="nowrap hint">${escapeHtml(fmtRelative(run.started_at))}</td>
        </tr>`).join('')}</tbody>
      </table></div>`;
    }

    function trendCard() {
      const { quality } = data;
      const scores = (quality.scores || []).map(Number).filter((value) => Number.isFinite(value));
      return `<div class="card">
        <div class="card-title">质量趋势 <span class="right fs11 muted">最近 ${scores.length} 次评估</span></div>
        <div class="dash-metric mt8">
          <span class="big">${quality.avg ?? '—'}</span>
          <span class="muted fs12">均分</span>
          <span class="right">${quality.passRate === null || quality.passRate === undefined ? '' : pill(`达标率 ${quality.passRate}%`, quality.passRate >= 80 ? 'ok' : quality.passRate >= 50 ? 'warn' : 'bad')}</span>
        </div>
        <div class="mt8">${scores.length >= 2 ? sparkline(scores.slice(-10), { width: 280, height: 52 }) : '<div class="hint">数据不足：至少两次质量评估后可显示趋势</div>'}</div>
        <div class="hint mt8">阈值 80 分（pass）· 60 分（revise）；低于 60 分触发重新生成。</div>
      </div>`;
    }

    function radarCard() {
      const dimensions = data.quality.dimensions;
      if (!dimensions || !Object.keys(dimensions).length) {
        return `<div class="card">
          <div class="card-title">能力雷达</div>
          ${emptyState('暂无维度评分', '质量 Agent 产出报告后显示五维雷达', '◔')}
          <div class="row" style="justify-content:center"><a class="btn sm ghost" href="#/quality">查看质量报告</a></div>
        </div>`;
      }
      const list = Object.values(dimensions);
      return `<div class="card">
        <div class="card-title">能力雷达 <span class="right fs11 muted">最近一次报告</span></div>
        <div class="row" style="justify-content:center;margin-top:4px">${radar(dimensions)}</div>
        <div class="stack mt8" style="gap:6px">
          ${list.slice(0, 5).map((dim) => barRow(dimLabel(dim.key), Math.round(Number(dim.score) || 0), 100, Number(dim.score) >= 80 ? 'jade' : Number(dim.score) >= 60 ? 'warn' : 'bad')).join('')}
        </div>
      </div>`;
    }

    function latestReportCard() {
      const latest = data.quality.latest;
      if (!latest) return '';
      return `<div class="card">
        <div class="card-title">最近质量报告 <span class="right">${latest.verdict ? verdictPill(latest.verdict) : ''}</span></div>
        <div class="row mt8" style="gap:14px;align-items:center">
          ${scoreRing(Number(latest.total_score ?? 0), 84)}
          <div class="grow">
            <div class="fs12">${escapeHtml(latest.node_key || '质量门禁')}${latest.iteration ? ` · 第 ${latest.iteration} 轮` : ''}</div>
            <div class="hint mt4">${escapeHtml(latest.created_at ? fmtDateTime(latest.created_at) : '')}</div>
            <a class="btn xs mt8" href="#/quality">打开报告</a>
          </div>
        </div>
      </div>`;
    }

    function workflowCard() {
      return `<div class="card">
        <div class="card-title">工作流说明</div>
        <div class="dash-flow mt8">
          ${WORKFLOW_NOTES.map(([no, title, desc]) => `<div class="dash-flow-row">
            <span class="no">${no}</span>
            <div><div class="t">${escapeHtml(title)}</div><div class="d">${escapeHtml(desc)}</div></div>
          </div>`).join('')}
        </div>
        <div class="row mt12"><a class="btn sm ghost" href="#/workflow">编排模板</a><a class="btn sm ghost" href="#/about">平台说明</a></div>
      </div>`;
    }

    function guideMarkup() {
      return `<div class="card pad-lg">
        <div class="card-title">三步跑通第一条标书</div>
        <div class="dash-guide">
          <div class="dash-guide-step">
            <div class="g-no">01</div>
            <div class="g-title">创建项目</div>
            <div class="g-body">粘贴招标文件全文并填写截止时间、预算；解析 Agent 会抽出资格/技术/商务/废标条款。</div>
          </div>
          <div class="dash-guide-step">
            <div class="g-no">02</div>
            <div class="g-title">启动工作流</div>
            <div class="g-body">Supervisor 产出节点计划；质量门禁在关键技术/合规节点自动检查，低分定向返工。</div>
          </div>
          <div class="dash-guide-step">
            <div class="g-no">03</div>
            <div class="g-title">审核与导出</div>
            <div class="g-body">在审核中心逐级签署，通过后在项目工作台导出 Word；未响应废标条款会阻断导出。</div>
          </div>
        </div>
        <div class="row mt16">
          <button class="btn primary" id="guide-new">＋ 新建项目</button>
          <button class="btn" id="guide-run">▶ 启动工作流</button>
          <a class="btn ghost" href="#/about">平台说明</a>
        </div>
      </div>`;
    }

    function paint() {
      if (!data) return;
      const empty = Number(data.projectTotal || 0) === 0;
      root.innerHTML = `${STYLE}
        ${headMarkup()}
        ${data.notice ? `<div class="dash-banner"><i>◆</i><span>${escapeHtml(data.notice)}</span></div>` : ''}
        ${kpis()}
        ${empty ? guideMarkup() : `<div class="grid side">
          <div class="stack-gap">
            <div class="card flush">
              <div class="card-head"><div class="card-title">待办审核
                  ${data.summary.overdue ? `<span class="pill bad">超时 ${data.summary.overdue}</span>` : ''}</div>
                <a class="btn sm ghost right" href="#/reviews">审核中心 →</a></div>
              ${reviewRows()}
            </div>
            <div class="card flush">
              <div class="card-head"><div class="card-title">最近运行</div>
                <a class="btn sm ghost right" href="#/runs">全部运行 →</a></div>
              ${runRows()}
            </div>
          </div>
          <div class="stack-gap">
            ${trendCard()}
            ${radarCard()}
            ${latestReportCard()}
            ${workflowCard()}
          </div>
        </div>`}
        ${empty ? `<div class="grid side mt12"><div class="stack-gap">${trendCard()}${workflowCard()}</div><div>${radarCard()}</div></div>` : ''}
        <div class="hint mt16">数据来源：${data.source === 'api' ? '聚合接口 /api/dashboard' : '项目 / 运行 / 审核 / 质量接口实时聚合'}</div>`;
      bind();
    }

    function bind() {
      for (const node of root.querySelectorAll('[data-review]')) {
        node.onclick = () => { location.hash = `#/review/${node.dataset.review}`; };
      }
      for (const node of root.querySelectorAll('[data-run]')) {
        node.onclick = () => { location.hash = `#/run/${node.dataset.run}`; };
      }
      for (const id of ['dash-new', 'guide-new']) {
        const node = root.querySelector(`#${id}`);
        if (node) node.onclick = () => { location.hash = '#/projects?new=1'; };
      }
      for (const id of ['dash-run', 'guide-run']) {
        const node = root.querySelector(`#${id}`);
        if (!node) continue;
        node.onclick = async () => {
          const original = node.textContent;
          node.disabled = true;
          node.textContent = '启动中…';
          try {
            await ctx.startRun();
            await reload();
          } catch (error) {
            toast('启动失败', error?.message || String(error), 'bad');
            node.disabled = false;
            node.textContent = original;
          }
        };
      }
    }

    async function reload() {
      try {
        data = await loadDashboard();
        paint();
      } catch (error) {
        if (!data) {
          root.innerHTML = `${STYLE}<div class="card"><div class="card-title">总览加载失败</div>
            <p class="hint mt8">${escapeHtml(error?.message || String(error))}</p>
            <button class="btn sm mt12" id="dash-retry">重试</button></div>`;
          const retry = root.querySelector('#dash-retry');
          if (retry) retry.onclick = () => reload();
        } else {
          toast('刷新失败', error?.message || String(error), 'bad');
        }
      }
    }

    root.innerHTML = `${STYLE}${headMarkup()}<div class="mt12">${skeletonRows(3)}</div>`;
    await reload();
    if (data) {
      timer = setInterval(() => { if (data) paint(); }, 60000);
    }

    return {
      refresh: async () => { await reload(); },
      destroy() { if (timer) clearInterval(timer); timer = null; },
    };
  },
};
