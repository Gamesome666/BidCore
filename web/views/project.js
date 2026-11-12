// 项目工作台：头部（项目元信息 + 启动工作流 + 导出）+ 7 个 tab。
// tab 状态走 URL ?tab=，切换用 history.replaceState 局部重绘，不触发整页/整视图重建。
import { api } from '../lib/api.js';
import {
  $, $$, escapeHtml, fmtDate, fmtDateTime, fmtRelative, countdown, pill, statusPill,
  toast, emptyState, loading, scoreRing,
} from '../lib/ui.js';
import {
  loadPlan, loadWorkspace, loadDeviation, loadExports, stepStates,
  STEP_META, pollTask, runStep, chapterWordTotal,
} from './project/data.js';

const TABS = [
  { key: 'overview', label: '概览' },
  { key: 'tender', label: '招标解析' },
  { key: 'plan', label: '技术方案' },
  { key: 'deviation', label: '响应偏离' },
  { key: 'duplicate', label: '查重' },
  { key: 'rejection', label: '废标检查' },
  { key: 'export', label: '导出' },
];

const MODULE_CACHE = new Map();
function loadTabModule(key) {
  if (!MODULE_CACHE.has(key)) {
    MODULE_CACHE.set(key, import(`./project/${key}.js`).then((mod) => mod.default || mod.mount));
  }
  return MODULE_CACHE.get(key);
}

const STYLE = `
<style>
  .wb-head { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
  .wb-back { margin-top: 3px; }
  .wb-title-wrap { min-width: 0; flex: 1; }
  .wb-eyebrow { font-size: 10.5px; letter-spacing: .2em; text-transform: uppercase; color: var(--accent); font-weight: 700; margin-bottom: 3px; }
  .wb-title { font-family: var(--serif); font-size: 27px; line-height: 1.24; color: var(--ink); letter-spacing: .005em; font-weight: 600; }
  .wb-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 14px; margin-top: 9px; font-size: 12px; color: var(--ink-3); }
  .wb-meta .k { color: var(--muted); font-size: 11px; letter-spacing: .04em; margin-right: 3px; }
  .wb-meta .v { color: var(--ink); font-variant-numeric: tabular-nums; }
  .wb-code { font-family: var(--mono); font-size: 11px; background: var(--paper-2); border-radius: 4px; padding: 1px 6px; color: var(--ink-3); }
  .wb-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .wb-tabbar { display: flex; align-items: flex-end; gap: 10px; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
  .wb-tabbar .tabs { border-bottom: 0; margin-bottom: 0; flex: 1; }
  .wb-tabbar .tab .count { background: var(--paper-2); }
  .wb-tabbar .tab.active .count { background: var(--accent-soft); color: var(--accent); }
  .wb-source { margin-bottom: 10px; flex: 0 0 auto; padding-bottom: 8px; }
  .wb-split { display: grid; grid-template-columns: minmax(0, 1fr) 330px; gap: 14px; align-items: start; }
  .wb-split-wide { display: grid; grid-template-columns: minmax(0, 1.12fr) minmax(320px, 1fr); gap: 14px; align-items: start; }
  .wb-split-editor { display: grid; grid-template-columns: minmax(300px, .72fr) minmax(0, 1.28fr); gap: 14px; align-items: start; }
  .wb-pane { max-height: calc(100vh - 258px); overflow: auto; }
  .wb-rule { height: 3px; background: var(--ink); border-radius: 2px; margin: 2px 0 14px; width: 44px; }
  .wb-steps { display: flex; border: 1px solid var(--line); border-radius: var(--radius); background: var(--card); overflow: hidden; }
  .wb-progress { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .wb-error { border: 1px solid var(--danger); background: var(--danger-soft); color: var(--danger); border-radius: var(--radius); padding: 14px 16px; }
  .wb-banner { display: flex; align-items: flex-start; gap: 9px; border: 1px solid var(--line); background: var(--card-2); border-radius: var(--radius); padding: 9px 12px; font-size: 11.8px; color: var(--ink-3); }
  .wb-banner i { font-style: normal; color: var(--accent); }
  .wb-banner.bad { border-color: #e7bdb8; background: var(--danger-soft); color: var(--danger); }
  .wb-banner.warn { border-color: #ecd9b4; background: var(--amber-soft); color: var(--amber); }
  .wb-tree-row { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
  .wb-tree-row:hover { background: var(--card-2); }
  .wb-tree-row.active { background: var(--accent-soft); border-color: #f0cfc0; }
  .wb-tree-row .t-no { font-family: var(--mono); font-size: 10.5px; color: var(--muted); min-width: 22px; }
  .wb-tree-row .t-title { flex: 1; min-width: 0; font-size: 12.6px; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wb-tree-row .t-words { font-size: 10.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .wb-editor { width: 100%; min-height: 420px; border: 1px solid var(--line-strong); border-radius: var(--radius-sm); padding: 12px 13px; font-family: var(--mono); font-size: 12.2px; line-height: 1.75; color: var(--ink); background: var(--card); resize: vertical; }
  .wb-editor:focus { outline: none; border-color: var(--accent); box-shadow: var(--focus); }
  .wb-kpi-inline { display: flex; gap: 22px; flex-wrap: wrap; }
  .wb-kpi-inline .n { font-family: var(--serif); font-size: 24px; color: var(--ink); font-variant-numeric: tabular-nums; line-height: 1.1; }
  .wb-kpi-inline .l { font-size: 10.5px; letter-spacing: .06em; color: var(--muted); text-transform: uppercase; }
  .wb-pair { border: 1px solid var(--line); border-radius: var(--radius-sm); padding: 10px 12px; background: var(--card); }
  .wb-pair + .wb-pair { margin-top: 8px; }
  .wb-pair .p-head { display: flex; align-items: center; gap: 8px; font-size: 12.4px; color: var(--ink); font-weight: 600; }
  .wb-pair .p-sample { font-size: 11.5px; color: var(--muted); margin-top: 6px; line-height: 1.6; border-left: 2px solid var(--line-strong); padding-left: 9px; }
  .wb-doc { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px 24px; }
  .wb-doc .md { font-size: 13px; line-height: 1.85; color: var(--ink-2); }
  mark.hl-hit { background: #fbe3b8; color: inherit; padding: 1px 2px; border-radius: 3px; box-shadow: 0 0 0 2px #fbe3b8; }
  .risk-row td { background: var(--danger-soft); }
  .risk-row:hover td { background: #fbe4e1; }
  .ex-check { display: flex; gap: 10px; align-items: flex-start; padding: 10px 0; border-bottom: 1px dashed var(--line); }
  .ex-check:last-child { border-bottom: 0; }
  .ex-mark { width: 18px; height: 18px; border-radius: 99px; display: grid; place-items: center; font-size: 11px; font-weight: 700; flex: 0 0 auto; margin-top: 1px; }
  .ex-check.ok .ex-mark { background: var(--jade-soft); color: var(--jade); }
  .ex-check.bad .ex-mark { background: var(--danger-soft); color: var(--danger); }
  .ex-label { font-size: 12.6px; font-weight: 600; color: var(--ink); }
  .ex-detail { font-size: 11.5px; color: var(--muted); margin-top: 1px; font-variant-numeric: tabular-nums; }
  .ex-hits { margin: 6px 0 0; padding-left: 16px; font-size: 11px; color: var(--ink-3); }
  .ex-hits li { margin: 2px 0; overflow-wrap: anywhere; }
  .ml8 { margin-left: 8px; }
  @media (max-width: 1180px) {
    .wb-split, .wb-split-wide, .wb-split-editor { grid-template-columns: 1fr; }
    .wb-pane { max-height: none; }
  }
  @media (max-width: 720px) {
    .wb-head { flex-direction: column; align-items: stretch; gap: 10px; }
    .wb-title { font-size: 21px; }
    .wb-meta { gap: 6px 10px; font-size: 11.5px; }
    .wb-actions { width: 100%; }
    .wb-actions .btn { flex: 1; }
    .wb-tabbar { flex-direction: column; align-items: stretch; gap: 4px; }
    .wb-source { display: flex; gap: 6px; padding-bottom: 8px; }
    .wb-editor { min-height: 300px; }
  }
</style>`;

function parseJson(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
}

function deadlineView(deadline) {
  if (!deadline) return { text: '未设置', kind: 'plain' };
  const ms = new Date(deadline).getTime() - Date.now();
  if (Number.isNaN(ms)) return { text: String(deadline), kind: 'plain' };
  const text = countdown(deadline);
  const kind = ms < 0 ? 'bad' : ms < 7 * 86400000 ? 'warn' : 'info';
  return { text, kind };
}

export default {
  title: '项目工作台',
  async render(root, ctx, params) {
    const pid = Number(params?.id || ctx.project?.id || 0);
    if (!pid) {
      root.innerHTML = `<div class="card">${emptyState('未指定项目', '请从项目管理进入一个项目工作台', '▤')}
        <div class="row" style="justify-content:center"><a class="btn primary" href="#/projects">返回项目管理</a></div></div>`;
      return null;
    }
    if (ctx.projects?.some((item) => item.id === pid) && ctx.project?.id !== pid) ctx.setProject(pid);

    root.innerHTML = `${STYLE}<div class="stack-gap">
      <div class="skeleton" style="width:46%;height:26px"></div>
      <div class="skeleton" style="width:72%;height:14px"></div>
      <div class="skeleton" style="width:100%;height:44px;border-radius:10px"></div>
      <div class="skeleton" style="width:100%;height:180px;border-radius:10px"></div>
    </div>`;

    const requestedTab = String(params?.query?.tab || '');
    let tab = TABS.some((item) => item.key === requestedTab) ? requestedTab : 'overview';

    let plan = null;
    let ws = null;
    let deviation = null;
    let exportsState = { source: 'local', items: [] };
    let checks = { rejection: null, duplicate: null };
    let settings = null;
    let disposed = false;
    let tabHandle = null;
    let cleanups = [];
    let inflight = null;

    const track = (fn) => { cleanups.push(fn); return fn; };
    const cleanupTab = () => {
      for (const fn of cleanups) { try { fn(); } catch { /* ignore */ } }
      cleanups = [];
    };

    function projectInfo() {
      const cached = ctx.projects?.find((item) => item.id === pid) || {};
      const detail = ws?.project || {};
      const merged = { ...cached, ...detail };
      const meta = merged.tender_meta && Object.keys(merged.tender_meta).length
        ? merged.tender_meta
        : parseJson(merged.tender_meta_json);
      return {
        ...merged,
        meta,
        client: meta.purchaser || meta.client || '',
        owner: merged.owner?.display_name || '',
        name: merged.name || `项目 #${pid}`,
        code: merged.code || '',
      };
    }

    async function reloadData() {
      if (inflight) return inflight;
      inflight = (async () => {
        plan = await loadPlan(pid);
        const [nextWs, nextDeviation, nextExports] = await Promise.all([
          loadWorkspace(pid, ctx, plan),
          loadDeviation(pid, plan),
          loadExports(pid),
        ]);
        ws = nextWs;
        deviation = nextDeviation;
        exportsState = nextExports;
        checks = {
          rejection: ws.checks?.rejection || plan.checks.rejection || null,
          duplicate: ws.checks?.duplicate || plan.checks.duplicate || null,
        };
        if (!settings) settings = await api.settings().catch(() => null);
      })();
      try { await inflight; } finally { inflight = null; }
    }

    async function trigger(step, { onTick } = {}) {
      const meta = STEP_META[step];
      if (!meta) throw new Error(`未知步骤：${step}`);
      const result = await runStep(pid, step, {});
      if (result.mode === 'local') {
        await reloadData();
        return { ...result, task: null };
      }
      if (step === 'export') {
        await reloadData();
        return result;
      }
      let task = result.task || null;
      if (task && task.status === 'error') {
        await reloadData();
        throw new Error(task.error || `${meta.label}失败`);
      }
      if (!task || task.status === 'running' || task.status === 'pausing') {
        const poller = pollTask({ onTick });
        track(() => poller.stop());
        task = (await poller.promise) || task;
      } else {
        onTick?.(task, { elapsed: 0 });
      }
      await reloadData();
      if (task?.status === 'error') throw new Error(task.error || `${meta.label}失败`);
      return { ...result, task };
    }

    function tabCount(key) {
      if (!plan) return '';
      if (key === 'plan') return plan.flatNodes.length || '';
      if (key === 'deviation') return deviation?.rows?.length || '';
      if (key === 'duplicate') {
        const similarity = checks.duplicate?.max_similarity;
        return similarity ? `${Math.round(similarity * 100)}%` : '';
      }
      if (key === 'rejection') {
        const summary = checks.rejection?.summary;
        const unresponded = summary?.veto_unresponded;
        return unresponded || (summary?.veto_total ? summary.veto_total : '') || '';
      }
      if (key === 'export') return exportsState.items.length || '';
      if (key === 'overview') return ws?.pendingReviews?.length || '';
      return '';
    }

    function renderTabs() {
      const info = projectInfo();
      const deadline = deadlineView(info.deadline);
      const pendingCount = ws?.pendingReviews?.length || 0;
      const currentRun = ws?.latestRun?.run || ws?.latestRun || null;
      const runStatus = currentRun?.status ? statusPill(currentRun.status) : '';
      const score = ws?.quality?.score;
      const steps = plan ? stepStates(plan, exportsState.items.length) : [];

      $('#wb-head', root).innerHTML = `
        <div class="wb-back"><a class="btn ghost sm" href="#/projects">← 项目列表</a></div>
        <div class="wb-title-wrap">
          <div class="wb-eyebrow">项目工作台</div>
          <h1 class="wb-title">${escapeHtml(info.name)}</h1>
          <div class="wb-meta">
            ${info.code ? `<span><span class="k">编号</span><span class="wb-code">${escapeHtml(info.code)}</span></span>` : ''}
            ${info.client ? `<span><span class="k">采购人</span><span class="v">${escapeHtml(info.client)}</span></span>` : ''}
            <span><span class="k">截止</span><span class="v">${escapeHtml(fmtDate(info.deadline) === '-' ? '未设置' : fmtDate(info.deadline))}</span>
              <span class="pill ${deadline.kind}">${escapeHtml(deadline.text)}</span></span>
            ${info.budget ? `<span><span class="k">预算</span><span class="v">${escapeHtml(info.budget)}</span></span>` : ''}
            ${info.industry ? `<span><span class="k">行业</span><span class="v">${escapeHtml(info.industry)}</span></span>` : ''}
            ${runStatus ? `<span><span class="k">最近运行</span>${runStatus}</span>` : ''}
            ${plan?.source === 'compat' ? '<span class="pill plain" title="新接口未实现，已降级到兼容接口">兼容接口</span>' : ''}
          </div>
        </div>
        <div class="wb-actions">
          <button class="btn" id="wb-run">▶ 启动工作流</button>
          <button class="btn primary" id="wb-export">导出 Word</button>
        </div>`;

      $('#wb-tabs', root).innerHTML = `
        <div class="wb-tabbar">
          <div class="tabs">
            ${TABS.map((item) => {
              const count = tabCount(item.key);
              return `<button class="tab ${item.key === tab ? 'active' : ''}" data-tab="${item.key}">${escapeHtml(item.label)}${count ? `<span class="count">${escapeHtml(String(count))}</span>` : ''}</button>`;
            }).join('')}
          </div>
          <div class="wb-source">
            ${Number(score) > 0 || score?.verdict ? `<span class="pill ${score >= 80 ? 'ok' : score >= 60 ? 'warn' : 'bad'}">质量 ${score} 分</span>` : ''}
            ${steps.filter((step) => step.done).length ? `<span class="pill plain">${steps.filter((step) => step.done).length}/${steps.length} 步完成</span>` : ''}
          </div>
        </div>`;

      for (const node of $$('[data-tab]', root)) {
        node.onclick = () => switchTab(node.dataset.tab);
      }
      const runButton = $('#wb-run', root);
      runButton.onclick = async () => {
        runButton.disabled = true;
        runButton.textContent = '启动中…';
        try {
          ctx.setProject(pid);
          await ctx.startRun();
        } catch (error) {
          toast('启动失败', error?.message || String(error), 'bad');
        } finally {
          runButton.disabled = false;
          runButton.textContent = '▶ 启动工作流';
        }
      };
      $('#wb-export', root).onclick = () => switchTab('export');
    }

    async function mountTab() {
      cleanupTab();
      renderTabs();
      const body = $('#wb-body', root);
      if (!body) return;
      body.innerHTML = loading();
      const mount = await loadTabModule(tab);
      if (disposed) return;
      try {
        tabHandle = (await mount(body, host)) || null;
      } catch (error) {
        console.error(error);
        body.innerHTML = `<div class="wb-error"><strong>该页签加载失败</strong>
          <div class="fs12 mt4">${escapeHtml(error?.message || String(error))}</div>
          <button class="btn sm mt8" id="wb-retry">重试</button></div>`;
        $('#wb-retry', body).onclick = () => mountTab();
      }
    }

    function switchTab(next) {
      if (!TABS.some((item) => item.key === next)) return;
      if (tab === next) return;
      tab = next;
      try { history.replaceState(null, '', `#/projects/${pid}?tab=${next}`); } catch { /* ignore */ }
      mountTab();
    }

    const host = {
      pid,
      ctx,
      get plan() { return plan; },
      get ws() { return ws; },
      get checks() { return checks; },
      get deviation() { return deviation; },
      get exports() { return exportsState; },
      get settings() { return settings; },
      reload: async () => { await reloadData(); await mountTab(); },
      mountTab,
      trigger,
      switchTab,
      track,
      toast,
      projectInfo,
      info: projectInfo,
      deadlineView,
    };

    try {
      await reloadData();
    } catch (error) {
      if (error?.status === 403) {
        root.innerHTML = `<div class="card">${emptyState('无权访问该项目', '请切换到你有权限的项目，或联系管理员', '⛔')}
          <div class="row" style="justify-content:center"><a class="btn" href="#/projects">返回项目管理</a></div></div>`;
        return null;
      }
      console.error(error);
      root.innerHTML = `${STYLE}<div class="wb-error"><strong>项目数据加载失败</strong>
        <div class="fs12 mt4">${escapeHtml(error?.message || String(error))}</div>
        <div class="row mt12"><button class="btn sm" id="wb-retry-all">重试</button><a class="btn sm ghost" href="#/projects">返回项目管理</a></div></div>`;
      const retry = $('#wb-retry-all', root);
      if (retry) retry.onclick = () => this.render(root, ctx, params);
      return null;
    }

    root.innerHTML = `${STYLE}
      <div class="wb-head" id="wb-head"></div>
      <div id="wb-tabs"></div>
      <div id="wb-body"></div>`;
    await mountTab();
    if (disposed) return null;

    return {
      async refresh() {
        if (disposed) return;
        try {
          await reloadData();
          await mountTab();
        } catch (error) {
          toast('刷新失败', error?.message || String(error), 'bad');
        }
      },
      destroy() {
        disposed = true;
        cleanupTab();
        if (tabHandle?.destroy) { try { tabHandle.destroy(); } catch { /* ignore */ } }
        tabHandle = null;
      },
    };
  },
};


