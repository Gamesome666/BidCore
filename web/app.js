// 应用外壳：登录态 / hash 路由 / 项目上下文 / 顶栏 / 侧边导航 / SSE / 全局徽标。
// 视图模块契约：export default { title, subtitle?, render(root, ctx, params) }，可选 destroy()。
import { api, store, connectEvents, ApiError } from './lib/api.js';
import { $, escapeHtml, toast, modal, statusPill, fmtRelative, loading } from './lib/ui.js';

const ROUTES = {
  login: { view: () => import('./views/login.js'), title: '登录' },
  dashboard: { view: () => import('./views/dashboard.js'), title: '总览' },
  projects: { view: () => import('./views/projects.js'), title: '项目管理' },
  project: { view: () => import('./views/project.js'), title: '项目工作台' },
  runs: { view: () => import('./views/runs.js'), title: '运行看板' },
  run: { view: () => import('./views/run.js'), title: '运行详情' },
  reviews: { view: () => import('./views/reviews.js'), title: '审核中心' },
  review: { view: () => import('./views/review.js'), title: '审核详情' },
  quality: { view: () => import('./views/quality.js'), title: '质量报告' },
  knowledge: { view: () => import('./views/knowledge.js'), title: '知识库' },
  agents: { view: () => import('./views/agents.js'), title: 'Agent 团队' },
  workflow: { view: () => import('./views/workflow.js'), title: '编排模板' },
  settings: { view: () => import('./views/settings.js'), title: '平台设置' },
  users: { view: () => import('./views/users.js'), title: '用户管理' },
  about: { view: () => import('./views/about.js'), title: '平台说明' },
};

const NAV = [
  { group: '总览', items: [{ id: 'dashboard', label: '工作台总览', icon: '◫' }] },
  { group: '标书生成', items: [
    { id: 'projects', label: '项目管理', icon: '▤' },
    { id: 'runs', label: '运行看板', icon: '⌗' },
  ] },
  { group: '人机协同', items: [
    { id: 'reviews', label: '审核中心', icon: '✓', badge: 'reviews' },
    { id: 'quality', label: '质量报告', icon: '◔' },
  ] },
  { group: '资产与团队', items: [
    { id: 'knowledge', label: '企业知识库', icon: '▦' },
    { id: 'agents', label: 'Agent 团队', icon: '◎' },
    { id: 'workflow', label: '编排模板', icon: '⋈' },
  ] },
  { group: '系统', items: [
    { id: 'settings', label: '平台设置', icon: '⚙' },
    { id: 'users', label: '用户管理', icon: '☰', adminOnly: true },
    { id: 'about', label: '平台说明', icon: 'ⓘ' },
  ] },
];

const ctx = {
  user: null,
  projects: [],
  project: null,
  params: {},
  query: {},
  navigate: (hash) => { location.hash = hash; },
  setProject,
  refreshShell,
  refreshCurrent: () => renderRoute(true),
  startRun,
  toast,
  statusPill,
  fmtRelative,
};

let currentView = null;
let disconnect = null;
let refreshTimer = null;
let badge = { mine: 0, pending: 0, overdue: 0 };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  return { segments, query: Object.fromEntries(new URLSearchParams(queryPart || '')), route: segments[0] || 'dashboard' };
}

function activeNavId(route) {
  if (route === 'project' || route === 'projects') return 'projects';
  if (route === 'run' || route === 'runs') return 'runs';
  if (route === 'review' || route === 'reviews') return 'reviews';
  return route;
}

/** 路径 → 视图键：/projects/:id → project，/runs/:id → run，/reviews/:id → review */
function viewKeyFor(route, segments) {
  if (route === 'projects' && segments[1]) return 'project';
  if (route === 'runs' && segments[1]) return 'run';
  if (route === 'reviews' && segments[1]) return 'review';
  if (route === 'login') return 'dashboard';
  return ROUTES[route] ? route : 'dashboard';
}

function renderNav(active) {
  const isAdmin = ctx.user?.role === 'admin';
  $('#nav').innerHTML = NAV.map((group) => {
    const items = group.items.filter((item) => !item.adminOnly || isAdmin);
    if (!items.length) return '';
    return `<div class="nav-group">${group.group}</div>${items.map((item) => `
      <a class="nav-item ${item.id === active ? 'active' : ''}" href="#/${item.id}">
        <span class="ico">${item.icon}</span><span>${item.label}</span>
        ${item.badge === 'reviews' ? `<span class="badge-dot" data-badge="reviews" ${badge.mine ? '' : 'hidden'}>${badge.mine}</span>` : ''}
      </a>`).join('')}`;
  }).join('');
}

function renderProjectSelect() {
  const select = $('#project-select');
  if (!select) return;
  if (!ctx.projects.length) {
    select.innerHTML = '<option value="">暂无项目</option>';
    return;
  }
  select.innerHTML = ctx.projects.map((p) => `<option value="${p.id}" ${p.id === store.projectId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
  select.onchange = () => {
    setProject(Number(select.value));
    const { route } = parseHash();
    if (route === 'projects' || route === 'dashboard') renderRoute(true);
    else location.hash = '#/projects';
  };
}

function renderTopbar() {
  $('#topbar-right').innerHTML = `
    <span class="pill plain" id="run-badge" hidden></span>
    <button class="btn primary" id="btn-new-run">▶ 启动工作流</button>
    <div class="user-chip" id="user-chip" title="点击退出登录">
      <div class="avatar">${escapeHtml((ctx.user?.display_name || 'U').slice(0, 1))}</div>
      <div class="meta"><strong>${escapeHtml(ctx.user?.display_name || '')}</strong><span>${escapeHtml(ctx.user?.title || (ctx.user?.role === 'admin' ? '管理员' : '成员'))}</span></div>
    </div>`;
  $('#btn-new-run').onclick = () => openStartRun();
  $('#user-chip').onclick = async () => {
    if (!window.confirm('退出登录？')) return;
    store.token = '';
    location.hash = '#/login';
    location.reload();
  };
}

function currentProjectName() {
  return ctx.projects.find((p) => p.id === store.projectId)?.name || '未选择项目';
}

async function startRun({ dryRun = false, objective } = {}) {
  const projectId = store.projectId;
  if (!projectId) { toast('请先选择项目', '', 'bad'); return null; }
  const res = await api.startRun({
    projectId,
    objective: objective || `为「${currentProjectName()}」生成投标文件`,
    dryRun,
  });
  toast('工作流已启动', `运行 ${res.run_id.slice(0, 12)}`, 'ok');
  location.hash = `#/run/${res.run_id}`;
  return res;
}

function openStartRun() {
  if (!ctx.projects.length) { toast('暂无项目', '先创建一个投标项目', 'bad'); return; }
  const options = ctx.projects.map((p) => `<option value="${p.id}" ${p.id === store.projectId ? 'selected' : ''}>${escapeHtml(p.name)}</option>`).join('');
  const { root, close } = modal({
    title: '启动 Multi-Agent 工作流',
    body: `<div class="field"><label>项目</label><select class="select" id="sr-project">${options}</select></div>
      <div class="field"><label>运行目标</label><input class="input" id="sr-objective" placeholder="默认：生成完整投标文件" /></div>
      <label class="row fs12" style="gap:8px"><input type="checkbox" id="sr-dry" /> 演练模式（dry-run：只跑计划与占位产物，不消耗模型额度）</label>
      <p class="hint mt12">启动后 Supervisor 会先产出计划，再按依赖与并行规则调度 8 个专业 Agent；命中人工门禁时运行会挂起并出现在审核中心。</p>`,
    footer: `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="sr-go">启动</button>`,
  });
  $('#sr-go', root).onclick = async () => {
    const projectId = Number($('#sr-project', root).value);
    const objective = $('#sr-objective', root).value.trim();
    const dryRun = $('#sr-dry', root).checked;
    setProject(projectId);
    const button = $('#sr-go', root);
    button.disabled = true;
    button.textContent = '启动中…';
    try {
      await startRun({ dryRun, objective });
      close();
    } catch (error) {
      toast('启动失败', error.message || String(error), 'bad');
      button.disabled = false;
      button.textContent = '启动';
    }
  };
}

function setProject(projectId) {
  store.projectId = projectId;
  ctx.project = ctx.projects.find((p) => p.id === projectId) || null;
  renderProjectSelect();
  connectStream();
}

function connectStream() {
  if (disconnect) { disconnect(); disconnect = null; }
  if (!store.token) return;
  disconnect = connectEvents(store.projectId, {
    onStatus: (on) => {
      const node = $('#sse-state');
      if (!node) return;
      node.classList.toggle('on', on);
      node.classList.toggle('off', !on);
      node.querySelector('span').textContent = on ? '实时通道已连接' : '实时通道重连中…';
    },
    onMessage: (channel, payload) => {
      if (channel === 'review') {
        if (payload.type === 'review.opened') toast('新的审核任务', `${payload.gate_key} · 第 ${payload.level}/${payload.level_total || 1} 级`, 'ok');
        if (payload.type === 'review.reminded') toast('审核超时提醒', payload.gate_key || '', 'warn');
        if (payload.type === 'review.escalated') toast('审核已升级', `转入第 ${payload.to_level} 级`, 'warn');
        refreshBadges();
      }
      if (channel === 'quality' && payload.type === 'quality.evaluated') refreshBadges();
      if (channel === 'tasks' && payload.task?.status === 'error') toast('任务失败', payload.task.error || '', 'bad');
      if (channel === 'workflow' && payload.type === 'run.failed') toast('运行失败', payload.error || '', 'bad');
      scheduleViewRefresh();
    },
  });
}

function scheduleViewRefresh() {
  if (typeof currentView?.refresh === 'function') {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { try { currentView.refresh(); } catch { /* ignore */ } }, 320);
    return;
  }
  if (window.__viewRefresh) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => window.__viewRefresh?.(), 320);
  }
}

async function refreshBadges() {
  if (!store.token) return;
  try {
    badge = await api.reviewSummary();
    const node = document.querySelector('[data-badge="reviews"]');
    if (node) { node.hidden = !badge.mine; node.textContent = badge.mine; }
    document.title = badge.mine ? `(${badge.mine}) BidCore · 标序` : 'BidCore · 标序 — 可人工干预的 Multi-Agent 投标平台';
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return;
  }
}

async function refreshShell() {
  await refreshBadges();
  renderNav(activeNavId(parseHash().route));
  renderTopbar();
  renderProjectSelect();
}

async function boot() {
  // 演示/截图工具支持 ?token=&projectId= 直接进入，写入后从地址栏抹除
  const params = new URLSearchParams(location.search);
  if (params.get('token')) {
    store.token = params.get('token');
    if (params.get('projectId')) store.projectId = Number(params.get('projectId'));
    params.delete('token'); params.delete('projectId');
    const clean = `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`;
    history.replaceState(null, '', clean);
  }
  if (!store.token) {
    showLoginChrome(false);
    await mountLogin();
    return;
  }
  try {
    const me = await api.me();
    ctx.user = me.user;
    ctx.projects = await api.projects();
    if (!store.projectId || !ctx.projects.some((p) => p.id === store.projectId)) {
      store.projectId = ctx.projects[0]?.id ?? 0;
    }
    ctx.project = ctx.projects.find((p) => p.id === store.projectId) || null;
  } catch {
    store.token = '';
    showLoginChrome(false);
    await mountLogin();
    return;
  }
  showLoginChrome(true);
  await refreshShell();
  connectStream();
  window.addEventListener('hashchange', () => renderRoute());
  renderRoute();
}

/** 未登录时把登录页挂到 body 上（#app 是隐藏的，不能复用 #view） */
async function mountLogin() {
  let host = document.getElementById('login-root');
  if (!host) {
    host = document.createElement('div');
    host.id = 'login-root';
    document.body.appendChild(host);
  }
  host.innerHTML = '';
  const mod = await import('./views/login.js');
  await mod.default.render(host, ctx);
}

function showLoginChrome(loggedIn) {
  document.getElementById('boot').hidden = true;
  document.getElementById('app').hidden = !loggedIn;
  const loginRoot = document.getElementById('login-root');
  if (loggedIn) {
    if (loginRoot) loginRoot.remove();
    document.querySelector('.sidebar')?.removeAttribute('hidden');
    document.querySelector('.topbar')?.removeAttribute('hidden');
  } else {
    document.querySelector('.sidebar')?.setAttribute('hidden', '');
    document.querySelector('.topbar')?.setAttribute('hidden', '');
  }
}

async function renderRoute(force = false) {
  const { route, segments, query } = parseHash();
  if (!store.token) {
    showLoginChrome(false);
    await mountLogin();
    return;
  }
  const key = viewKeyFor(route, segments);
  const entry = ROUTES[key] || ROUTES.dashboard;
  if (currentView?.destroy) { try { currentView.destroy(); } catch { /* ignore */ } }
  window.__viewRefresh = null;
  currentView = null;

  const root = $('#view');
  root.hidden = false;
  document.querySelector('.sidebar')?.removeAttribute('hidden');
  document.querySelector('.topbar')?.removeAttribute('hidden');
  root.innerHTML = loading();
  ctx.params = { id: segments[1], sub: segments[2], query, segments };
  ctx.query = query;
  renderNav(activeNavId(route));
  $('#crumb').textContent = entry.title;
  $('#crumb-sub').textContent = route === 'project' || route === 'run' ? currentProjectName() : '';

  try {
    const mod = await entry.view();
    const view = mod.default || mod;
    const result = await view.render(root, ctx, ctx.params);
    if (result && (result.refresh || result.destroy)) currentView = result;
    else if (view.refresh || view.destroy) currentView = view;
    document.querySelector('.sidebar')?.classList.remove('open');
    window.scrollTo({ top: 0, behavior: force ? 'auto' : 'instant' });
  } catch (error) {
    console.error(error);
    root.innerHTML = `<div class="card"><div class="card-title">页面加载失败</div>
      <p class="hint mt8">${escapeHtml(error.message || String(error))}</p>
      <button class="btn mt12" onclick="location.reload()">重新加载</button></div>`;
  }
}

window.addEventListener('DOMContentLoaded', boot);
window.addEventListener('beforeunload', () => disconnect?.());
