// 审核中心列表
import { api, store } from '../lib/api.js';
import { escapeHtml, fmtTime, statusPill, toast } from '../lib/ui.js';

const TABS = [
  { id: 'mine', label: '待我处理' },
  { id: 'all', label: '全部待审' },
  { id: 'overdue', label: '已超时' },
  { id: 'done', label: '已完成' },
];

export default {
  async render(root, ctx) {
    let tab = ctx.params.query.tab || 'mine';
    const renderList = async () => {
      const query = tab === 'mine'
        ? { status: 'pending', assignee: 'me' }
        : tab === 'all' ? { status: 'pending' }
          : tab === 'overdue' ? { status: 'pending', overdue: '1' } : {};
      let rows = await api.reviews(query);
      if (tab === 'done') rows = rows.filter((r) => !['pending', 'in_review'].includes(r.status));
      const summary = await api.reviewSummary();

      root.innerHTML = `
        <div class="grid c3" style="margin-bottom:16px">
          <div class="card tight"><div class="kpi"><span class="label">我的待办</span><span class="value">${summary.mine}</span><span class="delta">指派给我或我负责的项目</span></div></div>
          <div class="card tight"><div class="kpi"><span class="label">全部待审</span><span class="value">${summary.all}</span><span class="delta">含多级审核中间态</span></div></div>
          <div class="card tight"><div class="kpi"><span class="label">已超时</span><span class="value" style="color:${summary.overdue ? 'var(--bad)' : 'inherit'}">${summary.overdue}</span><span class="delta">超过 SLA 会升级或重复提醒</span></div></div>
        </div>
        <div class="card">
          <div class="card-head">
            <div class="tabs" style="margin:0;border:0">
              ${TABS.map((t) => `<div class="tab ${t.id === tab ? 'active' : ''}" data-tab="${t.id}">${t.label}</div>`).join('')}
            </div>
            <div class="card-actions"><button class="btn sm ghost" id="refresh">刷新</button></div>
          </div>
          <div class="table scroll-x">
            <table>
              <thead><tr><th>门禁</th><th>层级</th><th>项目</th><th>产物版本</th><th>SLA</th><th>状态</th><th></th></tr></thead>
              <tbody>
                ${rows.length ? rows.map((r) => `
                  <tr data-review="${r.id}">
                    <td><div>${escapeHtml(r.agent_label || r.gate_key)}</div><div class="mono">${escapeHtml(r.gate_key)} · ${r.id.slice(0, 10)}</div></td>
                    <td>第 ${r.level}/${r.level_total} 级</td>
                    <td>${escapeHtml(r.project_name || '')}</td>
                    <td class="mono">${escapeHtml(r.artifact_kind)} v${r.artifact_version}</td>
                    <td>${r.status === 'pending'
                      ? `<span class="pill ${r.overdue ? 'bad' : r.minutes_left < 60 ? 'warn' : ''}">${r.overdue ? '已超时' : `剩余 ${r.minutes_left} 分钟`}</span>`
                      : `<span class="hint">${fmtTime(r.closed_at)}</span>`}</td>
                    <td>${statusPill(r.status)}</td>
                    <td><a class="btn sm" href="#/review/${r.id}">${r.status === 'pending' ? '去审核' : '查看'}</a></td>
                  </tr>`).join('') : '<tr><td colspan="7" class="empty">暂无记录</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>`;

      root.querySelectorAll('[data-tab]').forEach((el) => {
        el.onclick = () => { tab = el.dataset.tab; renderList(); };
      });
      root.querySelectorAll('[data-review]').forEach((el) => {
        el.onclick = () => { location.hash = `#/review/${el.dataset.review}`; };
      });
      root.querySelector('#refresh').onclick = () => { toast('已刷新', '', 'ok', 1200); renderList(); };
    };
    await renderList();
    window.__viewRefresh = renderList;
    return { destroy() { window.__viewRefresh = null; } };
  },
};
