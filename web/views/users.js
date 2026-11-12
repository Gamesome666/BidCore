// 用户管理（admin）：账号 / 角色 / 部门 / 岗位 / 模块 + 新建 / 编辑 / 启停。
import { api } from '../lib/api.js';
import {
  $, $$, escapeHtml, pill, emptyState, loading, toast, modal, confirmDialog, fmtDate,
} from '../lib/ui.js';

const esc = escapeHtml;
const ROLE = { admin: '管理员', user: '成员' };
const MODULE_LABEL = { 'review-center': '审核中心', workflow: '工作流', projects: '项目', knowledge: '知识库', settings: '设置' };

function modulesOf(user) {
  try {
    const list = typeof user.modules === 'string' ? JSON.parse(user.modules) : user.modules;
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

export default {
  title: '用户管理',

  async render(root, ctx) {
    const state = { users: [], loading: true, error: '', unsupported: false, destroyed: false };
    const isAdmin = ctx.user?.role === 'admin';

    async function load() {
      try {
        state.users = await api.users();
        state.unsupported = false;
        state.error = '';
      } catch (error) {
        if (error.status === 404) state.unsupported = true;
        else state.error = error.message || String(error);
        state.users = [];
      }
      state.loading = false;
      paint();
    }

    function row(user) {
      const modules = modulesOf(user);
      return `<tr>
        <td><div class="mono ink">${esc(user.username)}</div>
          <div class="hint fs11">#${esc(String(user.id))}${user.created_at ? ` · ${fmtDate(user.created_at)} 加入` : ''}</div></td>
        <td>${esc(user.display_name || '—')}</td>
        <td><span class="pill ${user.role === 'admin' ? 'accent' : 'plain'}">${esc(ROLE[user.role] || user.role)}</span></td>
        <td>${esc(user.department || '—')}</td>
        <td>${esc(user.title || '—')}</td>
        <td>${modules.length ? modules.map((m) => `<span class="tag">${esc(MODULE_LABEL[m] || m)}</span>`).join(' ') : '<span class="hint">默认</span>'}</td>
        <td class="col-tight">
          <div class="row" style="gap:4px;justify-content:flex-end">
            <button class="btn xs" data-edit="${esc(String(user.id))}">编辑</button>
            ${user.enabled === undefined
              ? '<span class="hint fs11" title="后端未提供启停字段">启用中</span>'
              : `<button class="switch" role="switch" aria-checked="${user.enabled ? 'true' : 'false'}" data-toggle="${esc(String(user.id))}" title="启用/停用"></button>`}
          </div>
        </td>
      </tr>`;
    }

    function table() {
      if (state.loading) return `<div class="card">${loading('加载成员…')}</div>`;
      if (state.unsupported) {
        return `<div class="card">
          <div class="card-head" style="padding:0 0 10px;border:0">
            <div class="card-title">用户接口未就绪</div>
            <div class="right"><span class="pill warn">GET /api/users → 404</span></div>
          </div>
          <p class="hint fs12">前端能力已就绪，后端 <span class="mono">server/routes/users.mjs</span> 目前是空实现。接口上线后本页会自动呈现成员表格，无需改动前端。</p>
          <div class="table-wrap mt12" style="opacity:.55">
            <table class="table">
              <thead><tr><th>用户名</th><th>姓名</th><th>角色</th><th>部门</th><th>岗位</th><th>模块</th><th></th></tr></thead>
              <tbody>
                <tr><td class="mono">admin</td><td>—</td><td><span class="pill accent">管理员</span></td><td>—</td><td>—</td><td><span class="hint">—</span></td><td></td></tr>
                <tr><td class="mono">owner</td><td>—</td><td><span class="pill plain">成员</span></td><td>—</td><td>—</td><td><span class="hint">—</span></td><td></td></tr>
              </tbody>
            </table>
          </div>
          <div class="row mt12" style="gap:8px">
            <button class="btn sm" id="us-reload">重新检测接口</button>
            <span class="hint fs11">预期契约：<span class="mono">GET /api/users</span> · <span class="mono">POST /api/users</span> · <span class="mono">PATCH /api/users/:id</span></span>
          </div>
        </div>`;
      }
      if (state.error) {
        return `<div class="card"><div class="card-title">成员加载失败</div><p class="hint mt8">${esc(state.error)}</p>
          <button class="btn sm mt12" id="us-reload">重新加载</button></div>`;
      }
      if (!state.users.length) return `<div class="card">${emptyState('还没有成员', '点击右上角「新建用户」添加第一位同事', '☰')}</div>`;
      return `<div class="card flush">
        <div class="card-head">
          <div class="card-title">平台成员 <span class="hint" style="font-weight:400">${state.users.length} 人</span></div>
          <div class="right hint">角色决定审核权限；部门/岗位用于门禁指派与展示</div>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>用户名</th><th>姓名</th><th>角色</th><th>部门</th><th>岗位</th><th>模块</th><th class="col-tight"></th></tr></thead>
            <tbody>${state.users.map(row).join('')}</tbody>
          </table>
        </div>
      </div>`;
    }

    function paint() {
      if (state.destroyed) return;
      if (!isAdmin) {
        root.innerHTML = `<div class="page-head"><div><div class="page-title">用户管理</div></div></div>
          <div class="card">${emptyState('没有访问权限', '用户管理仅对管理员开放，请联系平台管理员', '☰')}</div>`;
        return;
      }
      const admins = state.users.filter((u) => u.role === 'admin').length;
      root.innerHTML = `
        <div class="page-head">
          <div>
            <div class="page-title">用户管理</div>
            <div class="page-desc">管理登录账号与审批权限。审核任务按 assignee/role 指派，转派需要管理员操作。</div>
          </div>
          <div class="page-actions">
            <button class="btn ghost" id="us-reload">刷新</button>
            <button class="btn primary" id="us-new" ${state.unsupported ? 'disabled' : ''}>＋ 新建用户</button>
          </div>
        </div>
        <div class="grid c4 mb16">
          <div class="kpi"><div class="k-label">成员总数</div><div class="k-value">${state.users.length}<small>人</small></div>
            <div class="k-foot">含管理员与项目成员</div></div>
          <div class="kpi accent"><div class="k-label">管理员</div><div class="k-value">${admins}<small>人</small></div>
            <div class="k-foot">可修改设置与流程模板</div></div>
          <div class="kpi"><div class="k-label">项目负责人</div><div class="k-value">${state.users.filter((u) => /负责人/.test(u.title || '')).length}<small>人</small></div>
            <div class="k-foot">默认第一级审核人</div></div>
          <div class="kpi jade"><div class="k-label">当前账号</div><div class="k-value" style="font-size:18px">${esc(ctx.user?.display_name || ctx.user?.username || '-')}</div>
            <div class="k-foot">${esc(ROLE[ctx.user?.role] || ctx.user?.role || '')} · ${esc(ctx.user?.title || '')}</div></div>
        </div>
        ${table()}`;
      bind();
    }

    function openEditor(user) {
      const isNew = !user;
      const box = modal({
        title: isNew ? '新建用户' : `编辑用户 · ${user.username}`,
        body: isNew
          ? `<div class="form-grid">
              <div class="field"><label>用户名</label><input class="input" id="u-username" placeholder="zhangsan" /></div>
              <div class="field"><label>初始密码</label><input class="input" id="u-password" type="password" placeholder="至少 6 位" /></div>
              <div class="field span2"><label>姓名</label><input class="input" id="u-name" placeholder="张三 · 技术负责人" /></div>
              <div class="field"><label>角色</label><select class="select" id="u-role">
                <option value="user">成员</option><option value="admin">管理员</option></select></div>
              <div class="field"><label>岗位</label><input class="input" id="u-title" placeholder="技术负责人" /></div>
              <div class="field span2"><label>部门</label><input class="input" id="u-dept" placeholder="技术方案部" /></div>
            </div>`
          : `<div class="form-grid">
              <div class="field span2"><label>账号</label><div class="mono fs12">${esc(user.username)} · #${esc(String(user.id))}</div></div>
              <div class="field"><label>角色</label><select class="select" id="u-role">
                <option value="user" ${user.role !== 'admin' ? 'selected' : ''}>成员</option>
                <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>管理员</option></select></div>
              <div class="field"><label>岗位</label><input class="input" id="u-title" value="${esc(user.title || '')}" /></div>
              <div class="field span2"><label>部门</label><input class="input" id="u-dept" value="${esc(user.department || '')}" /></div>
            </div>`,
        footer: `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="u-save">${isNew ? '创建' : '保存'}</button>`,
      });
      $('#u-save', box.root).onclick = async (event) => {
        const button = event.currentTarget;
        let body;
        if (isNew) {
          const username = $('#u-username', box.root).value.trim();
          const password = $('#u-password', box.root).value;
          if (!username) { toast('请填写用户名', '', 'warn'); return; }
          if (password.length < 6) { toast('密码太短', '至少 6 位', 'warn'); return; }
          body = {
            username, password,
            display_name: $('#u-name', box.root).value.trim() || username,
            role: $('#u-role', box.root).value,
            title: $('#u-title', box.root).value.trim(),
            department: $('#u-dept', box.root).value.trim(),
          };
        } else {
          body = {
            role: $('#u-role', box.root).value,
            title: $('#u-title', box.root).value.trim(),
            department: $('#u-dept', box.root).value.trim(),
          };
        }
        button.disabled = true;
        try {
          const saved = await api.saveUser(isNew ? null : user.id, body);
          box.close();
          if (isNew) {
            await load();
          } else {
            const idx = state.users.findIndex((u) => String(u.id) === String(user.id));
            if (idx >= 0) state.users[idx] = { ...state.users[idx], ...body, ...(saved || {}) };
            paint();
          }
          toast(isNew ? '用户已创建' : '用户已更新', body.display_name || user?.display_name || '', 'ok');
        } catch (error) {
          button.disabled = false;
          toast('保存失败', `${error.code || ''} ${error.message || ''}`.trim(), 'bad');
        }
      };
    }

    function bind() {
      const reload = $('#us-reload', root);
      if (reload) reload.onclick = () => { state.loading = true; paint(); load(); };
      const fresh = $('#us-new', root);
      if (fresh) fresh.onclick = () => openEditor(null);
      $$('[data-edit]', root).forEach((button) => {
        button.onclick = () => {
          const user = state.users.find((u) => String(u.id) === button.dataset.edit);
          if (user) openEditor(user);
        };
      });
      $$('[data-toggle]', root).forEach((button) => {
        button.onclick = async () => {
          const user = state.users.find((u) => String(u.id) === button.dataset.toggle);
          if (!user) return;
          const next = user.enabled ? 0 : 1;
          if (!next && !(await confirmDialog(`停用「${user.display_name || user.username}」？该账号将无法登录。`, { danger: true, okText: '停用' }))) return;
          button.disabled = true;
          try {
            await api.saveUser(user.id, { enabled: next });
            user.enabled = next;
            paint();
            toast(next ? '已启用' : '已停用', user.username, next ? 'ok' : 'warn');
          } catch (error) {
            button.disabled = false;
            toast('操作失败', `${error.code || ''} ${error.message || ''}`.trim(), 'bad');
          }
        };
      });
    }

    paint();
    await load();

    return {
      refresh: () => { load().catch((error) => toast('刷新失败', error.message, 'bad')); },
      destroy: () => { state.destroyed = true; },
    };
  },
};
