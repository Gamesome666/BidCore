// 标书工作台：复刻原仓库 technical-plan 单步流程（解析→目录→正文→检查→导出）
import { api, store } from '../lib/api.js';
import { escapeHtml, fmtTime, statusPill, verdictPill, toast } from '../lib/ui.js';

const STEPS = [
  { id: 'bid-analysis', label: '招标解析', desc: '抽取条款/评分/废标' },
  { id: 'outline-generation', label: '生成目录', desc: '按评分点映射章节' },
  { id: 'content-generation', label: '生成正文', desc: '逐章写作 + 引用' },
  { id: 'rejection-check', label: '废标检查', desc: '条款响应 / 偏离表' },
  { id: 'duplicate-analysis', label: '标书查重', desc: '章节相似度' },
];

export default {
  async render(root) {
    const projectId = store.projectId;
    if (!projectId) { root.innerHTML = '<div class="card">请先选择项目</div>'; return {}; }
    let state = await api.technicalPlan(projectId);
    let active = await api.taskActive();

    const renderAll = () => {
      const analysis = state.analysisRaw;
      const outline = state.outlineData;
      const content = state.content;
      const rejection = state.rejectionCheck;
      const dup = state.duplicateCheck;

      root.innerHTML = `
        <div class="card" style="margin-bottom:16px">
          <div class="card-head">
            <div class="card-title">单步标书流水线 <span class="sub">复刻原仓库 /api/tasks/start-* + /api/technical-plan 契约</span></div>
            <div class="card-actions"><span class="pill info">项目 ${projectId}</span></div>
          </div>
          <div class="grid c4" style="gap:10px">
            ${STEPS.map((s, i) => `
              <button class="action-btn ${s.id}" data-step="${s.id}" style="text-align:left">
                <strong>${i + 1}. ${s.label}</strong><span>${s.desc}</span>
              </button>`).join('')}
            <button class="action-btn" data-step="export" style="text-align:left">
              <strong>6. 导出 Word</strong><span>生成 .docx 并下载</span></button>
          </div>
          <div id="task-panel" style="margin-top:14px">${renderTaskPanel()}</div>
        </div>

        <div class="grid c2" style="grid-template-columns: minmax(0,1.35fr) minmax(320px,.85fr)">
          <div class="grid" style="gap:16px;align-content:start">
            <div class="card">
              <div class="card-head"><div class="card-title">解析结果</div>
                ${analysis ? `<span class="pill ok">${analysis.requirements.length} 条款</span>` : '<span class="pill">未解析</span>'}</div>
              ${analysis ? `
                <div class="hint" style="margin-bottom:10px;line-height:1.8">${escapeHtml(state.projectOverview || '')}</div>
                <div class="table scroll-x" style="max-height:340px;overflow:auto">
                  <table><thead><tr><th>编号</th><th>分类</th><th>条款</th><th>量化</th></tr></thead><tbody>
                    ${analysis.requirements.slice(0, 40).map((r) => `<tr>
                      <td class="mono">${r.id}</td>
                      <td><span class="pill ${r.category === 'veto' ? 'bad' : r.category === 'qualification' ? 'info' : ''}">${r.category}</span></td>
                      <td style="max-width:420px">${escapeHtml(r.text).slice(0, 110)}</td>
                      <td class="hint">${r.metrics.join(' ') || '—'}</td>
                    </tr>`).join('')}
                  </tbody></table>
                </div>` : '<div class="empty-state">点击「1. 招标解析」开始</div>'}
            </div>

            <div class="card">
              <div class="card-head"><div class="card-title">目录与正文</div>
                ${outline ? `<span class="pill ok">${outline.sections.length} 章</span>` : '<span class="pill">未生成</span>'}
                ${content ? `<span class="pill info">${content.total_words} 字</span>` : ''}</div>
              ${outline ? `<div class="node-list">
                ${outline.sections.map((s) => {
                  const sec = content?.sections.find((x) => x.id === s.id);
                  return `<div class="node-row" style="grid-template-columns:1fr auto">
                    <div><div class="name">${s.no} ${escapeHtml(s.title)}</div>
                      <div class="meta">目标 ${s.target_words} 字 · 映射 ${s.requirement_ids.length} 条要求</div></div>
                    <span class="hint">${sec ? `${sec.words} 字` : '—'}</span></div>`;
                }).join('')}
              </div>` : '<div class="empty-state">先完成解析，再点「2. 生成目录」</div>'}
            </div>
          </div>

          <div class="grid" style="gap:16px;align-content:start">
            <div class="card">
              <div class="card-head"><div class="card-title">废标检查</div>
                ${rejection ? verdictPill(rejection.risk_level === 'high' ? 'veto' : rejection.risk_level === 'medium' ? 'revise' : 'pass') : ''}</div>
              ${rejection ? `
                <dl class="kv" style="margin-bottom:10px">
                  <dt>废标条款</dt><dd>${rejection.summary.veto_total} 条，未响应 ${rejection.summary.veto_unresponded}</dd>
                  <dt>响应偏离</dt><dd>${rejection.summary.deviation_total} 条，部分满足 ${rejection.summary.deviation_partial}</dd>
                </dl>
                ${rejection.vetoes.slice(0, 4).map((v) => `<div class="finding"><span class="sev ${v.responded ? 'info' : 'veto'}"></span>
                  <div class="body"><div class="msg" style="font-size:12.5px">${escapeHtml(v.text).slice(0, 90)}</div>
                    <div class="evi">${v.responded ? '已响应' : '未响应'} · ${escapeHtml(v.clause)}</div></div></div>`).join('')}`
                : '<div class="empty-state">点「4. 废标检查」</div>'}
            </div>

            <div class="card">
              <div class="card-head"><div class="card-title">查重</div>
                ${dup ? `<span class="pill ${dup.max_similarity > 0.72 ? 'bad' : 'ok'}">最高 ${(dup.max_similarity * 100).toFixed(1)}%</span>` : ''}</div>
              ${dup ? (dup.pairs.length ? dup.pairs.slice(0, 5).map((p) => `
                <div class="node-row" style="grid-template-columns:1fr auto">
                  <div><div class="name" style="font-size:12.5px">${escapeHtml(p.a)} ↔ ${escapeHtml(p.b)}</div>
                    <div class="meta">${escapeHtml(p.sample).slice(0, 50)}…</div></div>
                  <span class="pill ${p.similarity > 0.72 ? 'bad' : 'warn'}">${(p.similarity * 100).toFixed(1)}%</span>
                </div>`).join('') : '<div class="hint">未发现重复章节</div>')
                : '<div class="empty-state">点「5. 标书查重」</div>'}
            </div>
          </div>
        </div>`;

      root.querySelectorAll('[data-step]').forEach((button) => {
        button.onclick = async () => {
          const step = button.dataset.step;
          button.disabled = true;
          try {
            if (step === 'export') {
              const res = await api.exportDocx(projectId);
              toast('Word 已生成', `${(res.size / 1024).toFixed(1)} KB · ${res.words} 字`, 'ok');
              window.open(res.file, '_blank');
            } else {
              await api.startTask(step);
              toast('任务已提交', step, 'ok');
              await poll();
            }
          } catch (error) {
            toast('操作失败', error.message, 'bad');
          } finally { button.disabled = false; }
        };
      });
    };

    const renderTaskPanel = () => {
      if (!active?.length) return '<div class="hint">没有运行中的任务 · 任意步骤可重复执行，正文/查重会基于最新状态重算</div>';
      return active.map((t) => `<div class="split" style="margin-bottom:6px">
        <span class="pill info">${escapeHtml(t.type)}</span>
        <div class="bar" style="flex:1"><i style="width:${t.progress}%"></i></div>
        <span class="hint">${t.progress}%</span>
        <span class="hint">${escapeHtml((t.logs || []).slice(-1)[0] || '')}</span>
      </div>`).join('');
    };

    const poll = async () => {
      for (let i = 0; i < 40; i += 1) {
        await new Promise((r) => setTimeout(r, 700));
        active = await api.taskActive();
        const panel = root.querySelector('#task-panel');
        if (panel) panel.innerHTML = renderTaskPanel();
        if (!active.length) break;
      }
      state = await api.technicalPlan(projectId);
      renderAll();
    };

    renderAll();
    return { destroy() { /* nothing */ } };
  },
};
