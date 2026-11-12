// 废标检查：逐条核对废标条款响应；未响应项标红并阻断导出
import {
  escapeHtml, fmtDateTime, pill, emptyState, toast,
} from '../../lib/ui.js';

function reportOf(host) {
  return host.checks.rejection || null;
}

function itemsOf(report) {
  const list = report?.items || report?.vetoes || [];
  return Array.isArray(list) ? list : [];
}

export default async function mount(container, host) {
  let disposed = false;
  let busy = false;

  function paint() {
    if (disposed) return;
    const report = reportOf(host);
    const items = itemsOf(report);
    const stats = report?.stats || {};
    const total = stats.veto_total ?? report?.veto_count ?? items.length;
    const unresponded = stats.unresponded ?? items.filter((item) => !item.responded).length;
    const highRisk = stats.high_risk ?? items.filter((item) => item.risk === '高').length;
    const blocker = unresponded > 0;

    container.innerHTML = `
      <div class="row wrap mb12" style="gap:10px">
        <div class="fs12 muted">逐条核对废标条款的响应证据；任一条未响应即视为废标风险，导出会被阻断。</div>
        <div class="right row" style="gap:6px">
          ${report ? pill(blocker ? '存在风险' : '全部已响应', blocker ? 'bad' : 'ok') : pill('未检查', 'plain')}
          <button class="btn primary sm" data-run ${busy ? 'disabled' : ''}>${report ? '重新检查' : '开始检查'}</button>
        </div>
      </div>

      ${blocker ? `<div class="wb-banner bad mb12"><i>▲</i><span><b>存在废标风险，导出将被阻断。</b> 有 ${unresponded} 条废标条款尚未在技术方案/商务响应中形成明确响应，请先补充正文再导出。</span></div>` : ''}
      ${busy ? `<div class="card bg-soft mb12" style="padding:11px 14px"><div class="row fs12"><span class="spinner"></span><span>检查执行中…</span></div></div>` : ''}

      <div class="grid c4" style="align-items:start">
        <div class="kpi ${blocker ? 'warn' : 'jade'}">
          <div class="k-label">废标条款</div>
          <div class="k-value">${total}<small>条</small></div>
          <div class="k-foot">来自招标文件「废标条款」章节</div>
        </div>
        <div class="kpi ${unresponded ? 'accent' : 'jade'}">
          <div class="k-label">未响应</div>
          <div class="k-value" style="color:${unresponded ? 'var(--danger)' : 'var(--jade)'}">${unresponded}<small>条</small></div>
          <div class="k-foot">${unresponded ? '导出将被阻断' : '全部已响应'}</div>
        </div>
        <div class="kpi">
          <div class="k-label">高风险条款</div>
          <div class="k-value">${highRisk}<small>条</small></div>
          <div class="k-foot">按条款风险等级统计</div>
        </div>
        <div class="kpi">
          <div class="k-label">检查时间</div>
          <div class="k-value" style="font-size:16px;line-height:1.5">${escapeHtml(report?.checked_at ? fmtDateTime(report.checked_at) : '—')}</div>
          <div class="k-foot">依据当前正文与商务响应</div>
        </div>
      </div>

      <div class="card flush mt12">
        <div class="card-head"><div class="card-title">废标条款逐条核对</div>
          <span class="right fs11 muted">未响应项标红</span></div>
        ${items.length ? `<div class="table-wrap" style="max-height:calc(100vh - 430px)">
          <table class="table compact">
            <thead><tr><th style="width:90px">条款</th><th style="width:42%">风险条款原文</th><th style="width:96px">风险</th><th style="width:100px">是否响应</th><th>证据 / 命中位置</th></tr></thead>
            <tbody>
              ${items.map((item) => `<tr class="${item.responded ? '' : 'risk-row'}">
                <td class="mono fs11">${escapeHtml(item.clause || item.id || '-')}</td>
                <td>${escapeHtml(item.requirement || item.text || '')}</td>
                <td>${pill(item.risk || '—', item.risk === '高' ? 'bad' : item.risk === '中' ? 'warn' : 'plain')}</td>
                <td>${item.responded ? pill('已响应', 'ok') : pill('未响应', 'bad')}</td>
                <td class="fs11 muted" style="overflow-wrap:anywhere">${escapeHtml(item.evidence || '—')}</td>
              </tr>`).join('')}
            </tbody>
          </table></div>`
    : emptyState('尚未执行废标检查', '正文与商务响应齐备后执行检查，未响应条款会阻断导出', '⚑')}
        ${report?.summary ? `<div class="card-foot fs11 muted">${escapeHtml(String(report.summary))}</div>` : ''}
      </div>`;

    const button = container.querySelector('[data-run]');
    if (button) {
      button.onclick = async () => {
        if (busy) return;
        busy = true;
        paint();
        try {
          await host.trigger('rejection');
          if (disposed) return;
          toast('废标检查完成', '', 'ok');
          await host.reload();
        } catch (error) {
          if (disposed) return;
          toast('检查失败', error?.message || String(error), 'bad');
          busy = false;
          paint();
        }
      };
    }
  }

  paint();
  return { refresh() { paint(); }, destroy() { disposed = true; } };
}
