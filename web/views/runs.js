// 运行看板：状态筛选 + 项目筛选 + 运行列表（节点完成度/待审数渐进增强）。
// 契约：export default { title, render(root, ctx, params) }，返回 { refresh, destroy }。
import { api } from '../lib/api.js';
import {
  $, $$, escapeHtml, pill, statusPill, emptyState, loading, toast, confirmDialog,
  fmtTime, fmtRelative, fmtDuration,
} from '../lib/ui.js';

const STATUS_TABS = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '运行中' },
  { key: 'waiting_human', label: '等待人工' },
  { key: 'completed', label: '已完成' },
  { key: 'failed', label: '失败' },
];
const ACTIVE = new Set(['planning', 'running', 'replanning']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const ENRICH_LIMIT = 12;

const shortId = (id, n = 12) => String(id || '').slice(0, n);
const pct = (done, total) => (total ? Math.round((done / total) * 100) : 0);

function durations(run) {
  const started = new Date(run.started_at).getTime();
  const ended = run.finished_at ? new Date(run.finished_at).getTime() : Date.now();
  if (Number.isNaN(started)) return '-';
  return fmtDuration(Math.max(0, ended - started));
}

export default {
  title: '运行看板',

  async render(root, ctx, params) {
    // 兜底二级路由：新版 app.js 已用 viewKeyFor 把 #/runs/:id 直接映射到 run 视图；
    // 老版本外壳只按首段匹配（会落到 runs 列表），这里仍能正确进入详情。
    const segments = params?.segments || [];
    if (segments.length > 1) {
      const mod = await import('./run.js');
      return mod.default.render(root, ctx, { ...params, id: segments[1] });
    }

    const state = {
      tab: 'all',
      projectId: 0,
      runs: [],
      projects: ctx.projects || [],
      detail: new Map(),
      busy: false,
      destroyed: false,
    };

    const coarse = () => {
      if (state.projectId) return state.runs.filter((r) => Number(r.project_id) === Number(state.projectId));
      return state.runs;
    };

    const visible = () => coarse().filter((run) => {
      if (state.tab === 'all') return true;
      if (state.tab === 'running') return ACTIVE.has(run.status);
      return run.status === state.tab;
    });

    const projectName = (run) => run.project_name
      || state.projects.find((p) => Number(p.id) === Number(run.project_id))?.name
      || `项目 #${run.project_id}`;

    /** 列表接口不带节点完成数：为可见的前 N 条运行拉快照，补齐完成度与真实待审数 */
    async function enrich() {
      const targets = visible().filter((r) => !state.detail.has(r.id)).slice(0, ENRICH_LIMIT);
      if (!targets.length) return false;
      const snaps = await Promise.all(targets.map((r) => api.run(r.id).catch(() => null)));
      let changed = false;
      snaps.forEach((snap, i) => {
        const run = targets[i];
        if (!snap) { state.detail.set(run.id, { failed: true }); return; }
        const nodes = snap.nodes || [];
        const done = nodes.filter((n) => n.status === 'succeeded' || n.status === 'skipped').length;
        const reviews = snap.reviews || [];
        state.detail.set(run.id, {
          done,
          total: nodes.length,
          waiting: reviews.filter((r) => r.status === 'pending' || r.status === 'in_review').length,
          score: snap.stats?.score ?? nodes.find((n) => n.quality_score)?.quality_score ?? null,
        });
        changed = true;
      });
      return changed;
    }

    function progressCell(run) {
      const info = state.detail.get(run.id);
      const total = info?.total ?? run.node_count ?? 0;
      if (info?.failed) return `<span class="hint">—</span>`;
      if (!total) return `<span class="hint">待规划</span>`;
      const done = info?.done ?? 0;
      return `<div class="row" style="gap:8px;min-width:118px">
          <div class="bar thin ${done === total ? 'jade' : ''}" style="flex:1"><i style="width:${pct(done, total)}%"></i></div>
          <span class="mono fs11">${done}/${total}</span>
        </div>`;
    }

    function waitingCell(run) {
      const count = state.detail.get(run.id)?.waiting ?? run.waiting ?? 0;
      if (!count) return '<span class="hint">—</span>';
      return `<a class="pill warn" href="#/reviews" title="前往审核中心">${count} 待审</a>`;
    }

    function tableHtml() {
      const rows = visible();
      if (!rows.length) {
        const filtered = state.tab !== 'all' || state.projectId;
        return emptyState(
          filtered ? '当前筛选条件下没有运行' : '还没有运行记录',
          filtered ? '换个状态或项目筛选看看' : '点击右上角「启动工作流」，或从项目工作台发起一次标书生成',
          '⌗',
        );
      }
      return `<div class="table-wrap scroll-y" style="max-height:calc(100vh - 330px)">
        <table class="table">
          <thead><tr>
            <th>运行 ID</th><th>项目</th><th>状态</th><th>节点完成度</th>
            <th>计划版本</th><th class="num">耗时</th><th>开始时间</th><th>待审</th>
          </tr></thead>
          <tbody>
            ${rows.map((run) => `
              <tr class="clickable" data-run="${escapeHtml(run.id)}">
                <td>
                  <div class="mono ink fw6">${escapeHtml(shortId(run.id))}</div>
                  <div class="hint ellipsis" style="max-width:240px">${escapeHtml(run.objective || '')}</div>
                </td>
                <td><div class="ellipsis" style="max-width:180px">${escapeHtml(projectName(run))}</div>
                  <div class="hint fs11 mono">${escapeHtml(run.def_key || '')} v${escapeHtml(String(run.def_version || 1))}</div></td>
                <td>${statusPill(run.status)}
                  ${run.dry_run ? '<span class="pill violet" title="演练模式：不消耗模型额度">dry-run</span>' : ''}</td>
                <td>${progressCell(run)}</td>
                <td class="mono">v${escapeHtml(String(run.plan_version || 0))}</td>
                <td class="num nowrap">${durations(run)}</td>
                <td class="nowrap"><div>${fmtTime(run.started_at)}</div>
                  <div class="hint fs11">${fmtRelative(run.started_at)}</div></td>
                <td>${waitingCell(run)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    }

    function kpis() {
      const list = coarse();
      const active = list.filter((r) => ACTIVE.has(r.status)).length;
      const waiting = list.filter((r) => r.status === 'waiting_human').length;
      const done = list.filter((r) => r.status === 'completed').length;
      const failed = list.filter((r) => r.status === 'failed').length;
      const nodes = list.reduce((sum, r) => sum + Number(r.node_count || 0), 0);
      return `<div class="grid c4 mb16">
        <div class="kpi"><div class="k-label">运行总数</div>
          <div class="k-value">${list.length}<small>次</small></div>
          <div class="k-foot">${escapeHtml(state.projectId ? '当前项目' : '全部项目')} · 节点 ${nodes} 个</div></div>
        <div class="kpi ${active ? 'accent' : ''}"><div class="k-label">进行中</div>
          <div class="k-value">${active}<small>次</small></div>
          <div class="k-foot">${active ? `Supervisor 正在调度 ${active} 条流水线` : '当前没有活跃流水线'}</div></div>
        <div class="kpi ${waiting ? 'warn' : ''}"><div class="k-label">等待人工</div>
          <div class="k-value">${waiting}<small>次</small></div>
          <div class="k-foot">命中审核门禁，需在审核中心处理</div></div>
        <div class="kpi ${failed ? 'warn' : 'jade'}"><div class="k-label">已完成 / 失败</div>
          <div class="k-value">${done}<small>/ ${failed}</small></div>
          <div class="k-foot">完成率 ${list.length ? Math.round((done / list.length) * 100) : 0}%</div></div>
      </div>`;
    }

    function filters() {
      const tabs = STATUS_TABS.map((tab) => {
        const count = coarse().filter((r) => (tab.key === 'all' ? true : tab.key === 'running' ? ACTIVE.has(r.status) : r.status === tab.key)).length;
        return `<button data-tab="${tab.key}" class="${state.tab === tab.key ? 'active' : ''}">${tab.label}
          <span style="margin-left:5px;font-size:10.5px;opacity:.72">${count}</span></button>`;
      }).join('');
      const options = [`<option value="0" ${state.projectId ? '' : 'selected'}>全部项目（${state.projects.length}）</option>`]
        .concat(state.projects.map((p) => `<option value="${p.id}" ${Number(state.projectId) === Number(p.id) ? 'selected' : ''}>${escapeHtml(p.name)}</option>`))
        .join('');
      return `<div class="page-head">
        <div>
          <div class="page-title">运行看板</div>
          <div class="page-desc">每次标书生成都是一条可观测的工作流：Supervisor 生成计划 → 并行调度专业 Agent → 命中质量/人工门禁时挂起。</div>
        </div>
        <div class="page-actions">
          <select class="select slim" id="runs-project" style="min-width:220px" title="按项目筛选">${options}</select>
          <button class="btn primary" id="runs-start">▶ 启动工作流</button>
        </div>
      </div>
      <div class="flex-between mb12">
        <div class="segmented">${tabs}</div>
        <div class="hint">SSE 实时刷新 · 点击任意行进入运行详情</div>
      </div>`;
    }

    function paint() {
      if (state.destroyed) return;
      root.innerHTML = `${filters()}${kpis()}
        <div class="card flush">${state.loading ? loading('加载运行记录…') : tableHtml()}</div>`;
      bind();
    }

    function bind() {
      $$('[data-tab]', root).forEach((button) => {
        button.onclick = () => { state.tab = button.dataset.tab; paint(); enrich().then((changed) => changed && paint()); };
      });
      const projectSelect = $('#runs-project', root);
      if (projectSelect) {
        projectSelect.onchange = (event) => {
          state.projectId = Number(event.target.value || 0);
          paint();
          enrich().then((changed) => changed && paint());
        };
      }
      $('#runs-start', root).onclick = async (event) => {
        const button = event.currentTarget;
        const project = state.projects.find((p) => Number(p.id) === Number(state.projectId || 0));
        const name = project?.name || ctx.project?.name || '当前项目';
        if (!(await confirmDialog(`立即为「${name}」启动一次标书生成工作流？\nSupervisor 会先产出计划，再并行调度专业 Agent。`, { okText: '启动' }))) return;
        button.disabled = true;
        button.textContent = '启动中…';
        try {
          await ctx.startRun?.({});
        } catch (error) {
          toast('启动失败', error.message || String(error), 'bad');
        } finally {
          button.disabled = false;
          button.textContent = '▶ 启动工作流';
        }
      };
      $$('[data-run]', root).forEach((row) => {
        row.onclick = () => { ctx.navigate?.(`#/runs/${row.dataset.run}`); };
      });
      $$('[data-run] a', root).forEach((link) => { link.onclick = (event) => event.stopPropagation(); });
    }

    async function load() {
      try {
        state.runs = await api.runs();
      } catch (error) {
        root.innerHTML = `<div class="page-head"><div><div class="page-title">运行看板</div></div></div>
          <div class="card"><div class="card-title">运行列表加载失败</div>
          <p class="hint mt8">${escapeHtml(error.message || String(error))}</p></div>`;
        toast('加载失败', error.message || String(error), 'bad');
        return;
      }
      state.loading = false;
      paint();
      const changed = await enrich();
      if (changed) paint();
    }

    paint();
    await load();

    return {
      refresh: () => { load().catch((error) => toast('刷新失败', error.message, 'bad')); },
      destroy: () => { state.destroyed = true; },
    };
  },
};
