// 审核中心：我的待办 / 全部待办 / 已超时 / 已处理 + SLA 倒计时 + 多级进度。
import { api } from '../lib/api.js';
import {
  $, $$, escapeHtml, pill, statusPill, emptyState, loading, toast, fmtTime, fmtRelative,
} from '../lib/ui.js';

const esc = escapeHtml;

const TABS = [
  { key: 'mine', label: '我的待办', desc: '指派给我、且尚未处理的审核任务' },
  { key: 'all', label: '全部待办', desc: '全平台所有待处理的人工门禁' },
  { key: 'overdue', label: '已超时', desc: '超过 SLA 时限，可能触发升级或催办' },
  { key: 'done', label: '已处理', desc: '已作出决策（通过/驳回/修改/要求重新分析）的历史任务' },
];
const DONE_STATUS = new Set(['approved', 'rejected', 'modified', 'reanalyzed', 'escalated', 'cancelled']);
const STATUS_LABEL = {
  pending: '待审核', in_review: '审核中', approved: '已通过', rejected: '已驳回',
  modified: '已修改', reanalyzed: '要求重新分析', escalated: '已升级', cancelled: '已作废',
};
const PRIORITY_LABEL = { 0: '普通', 1: '较急', 2: '紧急', 3: '加急' };

function slaPill(row) {
  if (row.status !== 'pending') {
    return pill(STATUS_LABEL[row.status] || row.status, DONE_STATUS.has(row.status) ? (row.status === 'approved' ? 'ok' : 'violet') : 'plain');
  }
  const minutes = Number(row.minutes_left ?? Math.round((new Date(row.sla_due_at).getTime() - Date.now()) / 60000));
  if (row.overdue || minutes < 0) return pill(`已超时 ${Math.abs(minutes)} 分钟`, 'bad');
  if (minutes < 60) return pill(`剩 ${minutes} 分钟`, 'warn');
  const hours = Math.floor(minutes / 60);
  return pill(`剩 ${hours} 小时 ${minutes % 60} 分`, 'plain');
}

function levelTrack(level, total) {
  const n = Math.max(1, Number(total) || 1);
  const cur = Math.min(n, Math.max(1, Number(level) || 1));
  if (n === 1) return '<span class="tag soft" title="该门禁只有一级审核">单级</span>';
  return `<div class="level-track" style="width:96px" title="第 ${cur}/${n} 级">
    ${Array.from({ length: n }, (_, i) => `<span class="lv ${i + 1 < cur ? 'done' : i + 1 === cur ? 'active' : ''}"></span>`).join('')}
  </div>`;
}

export default {
  title: '审核中心',

  async render(root, ctx, params) {
    // 兜底二级路由：新版 app.js 已用 viewKeyFor 映射 #/reviews/:id；老版本外壳只匹配首段。
    const segments = params?.segments || [];
    if (segments.length > 1) {
      const mod = await import('./review.js');
      return mod.default.render(root, ctx, { ...params, id: segments[1] });
    }

    const state = {
      tab: 'mine',
      projectId: Number(ctx.query?.projectId || 0),
      rows: [],
      summary: { mine: 0, all: 0, overdue: 0 },
      loading: true,
      error: '',
      destroyed: false,
      timer: null,
    };

    const projectName = (row) => row.project_name
      || (ctx.projects || []).find((p) => Number(p.id) === Number(row.project_id))?.name
      || `项目 #${row.project_id}`;

    async function query() {
      const base = {};
      if (state.projectId) base.projectId = state.projectId;
      if (state.tab === 'mine') return api.reviews({ ...base, status: 'pending', assignee: 'me' });
      if (state.tab === 'all') return api.reviews({ ...base, status: 'pending' });
      if (state.tab === 'overdue') return api.reviews({ ...base, overdue: '1' });
      const rows = await api.reviews(base);
      return rows.filter((r) => DONE_STATUS.has(r.status));
    }

    async function load(first = false) {
      try {
        const summary = await api.reviewSummary().catch(() => state.summary);
        state.summary = summary || state.summary;
        // 管理员通常没有指派给自己的任务：若"我的待办"为空而平台有待办，默认落到"全部待办"
        if (first && state.tab === 'mine' && !state.summary.mine && state.summary.all) state.tab = 'all';
        const rows = await query();
        state.rows = rows || [];
        state.error = '';
      } catch (error) {
        state.error = error.message || String(error);
        state.rows = [];
      }
      state.loading = false;
      paint();
    }

    function leftRail() {
      return `<div class="card pad-sm">
        <div class="hint fs11" style="letter-spacing:.1em;text-transform:uppercase;padding:6px 6px 8px">筛选</div>
        ${TABS.map((tab) => {
          const count = tab.key === 'mine' ? state.summary.mine
            : tab.key === 'all' ? state.summary.all
              : tab.key === 'overdue' ? state.summary.overdue
                : '';
          return `<button class="list-row ${state.tab === tab.key ? 'active' : ''}" data-tab="${tab.key}"
              style="width:100%;text-align:left;background:none;border:0;border-radius:8px;cursor:pointer">
            <div class="l-main"><div class="l-title">${tab.label}</div>
              <div class="l-sub" style="display:block">${tab.desc}</div></div>
            ${count === '' ? '' : Number(count) > 0
              ? `<span class="badge-dot" style="${tab.key === 'overdue' ? 'background:var(--danger)' : ''}">${count}</span>`
              : '<span class="hint fs11">0</span>'}
          </button>`;
        }).join('')}
        <div class="divider"></div>
        <div class="hint fs11 mb4">项目</div>
        <select class="select slim w-full" id="rev-project">
          <option value="0" ${state.projectId ? '' : 'selected'}>全部项目</option>
          ${(ctx.projects || []).map((p) => `<option value="${p.id}" ${Number(state.projectId) === Number(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
        <p class="hint fs11 mt12">命中人工门禁时运行会挂起（waiting_human），审核通过后自动继续。</p>
      </div>`;
    }

    function card(row) {
      const pending = row.status === 'pending';
      return `<div class="card" data-review="${esc(row.id)}" style="cursor:pointer;${row.overdue ? 'border-left:3px solid var(--danger)' : pending ? 'border-left:3px solid var(--accent)' : ''}">
        <div class="flex-between" style="align-items:flex-start">
          <div style="min-width:0">
            <div class="row wrap" style="gap:6px">
              <span class="fw6 ink">${esc(projectName(row))}</span>
              <span class="pill plain mono">${esc(row.gate_key)}</span>
              <span class="pill ${row.priority >= 2 ? 'bad' : row.priority === 1 ? 'warn' : 'plain'}">优先级 ${esc(PRIORITY_LABEL[row.priority] ?? row.priority ?? '普通')}</span>
            </div>
            <div class="row wrap mt8" style="gap:10px">
              <span class="hint fs11">第 ${esc(String(row.level))}/${esc(String(row.level_total))} 级</span>
              ${levelTrack(row.level, row.level_total)}
              <span class="hint fs11">·</span>
              <span class="hint fs11">产物 <span class="mono">${esc(row.artifact_kind || '-')} v${esc(String(row.artifact_version ?? '?'))}</span></span>
              ${row.agent_label && row.agent_label !== row.gate_key ? `<span class="hint fs11">· ${esc(row.agent_label)}</span>` : ''}
            </div>
          </div>
          <div style="text-align:right;display:flex;flex-direction:column;gap:6px;align-items:flex-end">
            ${slaPill(row)}
            <span class="hint fs11">${row.sla_due_at ? `截止 ${fmtTime(row.sla_due_at)}` : ''}</span>
          </div>
        </div>
        <div class="flex-between mt12" style="padding-top:10px;border-top:1px dashed var(--line)">
          <div class="row" style="gap:8px">
            ${statusPill(row.status)}
            ${row.run_status ? `<span class="hint fs11">运行 ${statusPill(row.run_status)}</span>` : ''}
            <span class="hint fs11">创建 ${fmtRelative(row.created_at)}</span>
          </div>
          <span class="btn xs">打开审核 →</span>
        </div>
      </div>`;
    }

    function list() {
      if (state.loading) return `<div class="card">${loading('加载审核任务…')}</div>`;
      if (state.error) {
        return `<div class="card"><div class="card-title">审核任务加载失败</div>
          <p class="hint mt8">${esc(state.error)}</p>
          <button class="btn sm mt12" data-reload>重新加载</button></div>`;
      }
      if (!state.rows.length) {
        const guide = {
          mine: ['当前没有待审核任务', '所有指派给你的门禁都已处理完毕；命中新门禁时会通过实时通道提醒。'],
          all: ['平台上没有待处理的审核', '启动一次工作流并执行到人工门禁即可在这里看到任务。'],
          overdue: ['没有超时的审核任务', '所有门禁都在 SLA 时限内。'],
          done: ['还没有已处理的审核记录', '处理过的任务会保留决策、意见与目标节点，供追溯。'],
        }[state.tab];
        return `<div class="card">${emptyState(guide[0], guide[1], '✓')}
          <div class="row" style="justify-content:center;gap:8px;padding-bottom:16px">
            <a class="btn sm" href="#/runs">查看运行看板</a>
            <a class="btn sm ghost" href="#/dashboard">回到总览</a>
          </div></div>`;
      }
      return `<div class="stack-gap">${state.rows.map(card).join('')}</div>`;
    }

    function paint() {
      if (state.destroyed) return;
      root.innerHTML = `
        <div class="page-head">
          <div>
            <div class="page-title">审核中心</div>
            <div class="page-desc">Human-in-the-Loop 主场：每条任务对应一个被挂起的工作流节点。通过后自动续跑；驳回/修改会定向回退到上游 Agent。</div>
          </div>
          <div class="page-actions">
            <button class="btn" data-reload>刷新</button>
          </div>
        </div>
        <div class="grid c3 mb16">
          <div class="kpi accent"><div class="k-label">待我处理</div>
            <div class="k-value">${state.summary.mine ?? 0}<small>项</small></div>
            <div class="k-foot">指派给你的待办门禁</div></div>
          <div class="kpi"><div class="k-label">全部待处理</div>
            <div class="k-value">${state.summary.all ?? 0}<small>项</small></div>
            <div class="k-foot">全平台待人工决策</div></div>
          <div class="kpi ${state.summary.overdue ? 'warn' : 'jade'}"><div class="k-label">已超时</div>
            <div class="k-value">${state.summary.overdue ?? 0}<small>项</small></div>
            <div class="k-foot">超过 SLA，按策略催办或升级</div></div>
        </div>
        <div style="display:grid;grid-template-columns:264px minmax(0,1fr);gap:16px;align-items:start">
          ${leftRail()}
          <div>
            <div class="section-head"><div class="section-title">${TABS.find((t) => t.key === state.tab).label}</div>
              <span class="hint">${state.rows.length} 条</span></div>
            ${list()}
          </div>
        </div>`;
      bind();
    }

    function bind() {
      $$('[data-tab]', root).forEach((button) => {
        button.onclick = () => { state.tab = button.dataset.tab; state.loading = true; paint(); load(); };
      });
      $$('[data-reload]', root).forEach((button) => { button.onclick = () => { state.loading = true; paint(); load(); }; });
      const select = $('#rev-project', root);
      if (select) select.onchange = (event) => { state.projectId = Number(event.target.value || 0); state.loading = true; paint(); load(); };
      $$('[data-review]', root).forEach((node) => {
        node.onclick = () => { location.hash = `#/reviews/${node.dataset.review}`; };
      });
    }

    paint();
    await load(true);

    // SLA 倒计时每分钟自刷新（destroy 清理）
    state.timer = setInterval(() => {
      if (state.destroyed) return;
      if (state.rows.some((r) => r.status === 'pending')) paint();
    }, 60_000);

    return {
      refresh: () => { load().catch((error) => toast('刷新失败', error.message, 'bad')); },
      destroy: () => { state.destroyed = true; if (state.timer) clearInterval(state.timer); },
    };
  },
};
