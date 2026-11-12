// 查重：最高相似度 + Top 重复对（A/B 章节、相似度条），阈值来自平台设置
import {
  escapeHtml, fmtDateTime, pill, emptyState, toast,
} from '../../lib/ui.js';

function thresholdOf(host, report) {
  const fromReport = report?.stats?.threshold;
  if (Number.isFinite(Number(fromReport)) && Number(fromReport) > 0) return Number(fromReport);
  const fromSettings = host.settings?.quality?.thresholds?.duplicateSimilarity;
  if (Number.isFinite(Number(fromSettings)) && Number(fromSettings) > 0) return Number(fromSettings);
  return 0.72;
}

export default async function mount(container, host) {
  let disposed = false;
  let busy = false;

  const report = () => host.checks.duplicate || null;

  function pairsMarkup(reportData, threshold) {
    const pairs = reportData?.pairs || [];
    if (!pairs.length) return emptyState('未发现明显重复段落', '也可能是尚未执行查重：正文生成后点击右上角「重新查重」', '⧉');
    return pairs.map((pair) => {
      const score = Number(pair.score ?? pair.similarity ?? 0);
      const pct = Math.round(score * 100);
      const over = score >= threshold;
      return `<div class="wb-pair">
        <div class="p-head">
          <span class="ellipsis" style="max-width:40%">A · ${escapeHtml(pair.a || '-')}</span>
          <span class="muted">⇄</span>
          <span class="ellipsis" style="max-width:40%">B · ${escapeHtml(pair.b || '-')}</span>
          <span class="right row" style="gap:6px">${pill(`${pct}%`, over ? 'bad' : 'plain')}</span>
        </div>
        <div class="bar mt8 ${over ? 'bad' : 'jade'}"><i style="width:${Math.max(2, Math.min(100, pct))}%"></i></div>
        ${pair.excerpt || pair.sample ? `<div class="p-sample">${escapeHtml(pair.excerpt || pair.sample)}</div>` : ''}
      </div>`;
    }).join('');
  }

  function paint() {
    if (disposed) return;
    const data = report();
    const threshold = thresholdOf(host, data);
    const max = Number(data?.max_similarity ?? 0);
    const pct = Math.round(max * 100);
    const over = max >= threshold;
    const stats = data?.stats || {};

    container.innerHTML = `
      <div class="row wrap mb12" style="gap:10px">
        <div class="fs12 muted">以章节为粒度两两比对（字符 2-gram），重复段落在审核中会被要求改写或补证。</div>
        <div class="right row" style="gap:6px">
          <span class="pill plain">阈值 ${Math.round(threshold * 100)}%</span>
          <button class="btn primary sm" data-run ${busy ? 'disabled' : ''}>${data ? '重新查重' : '开始查重'}</button>
        </div>
      </div>
      ${busy ? `<div class="card bg-soft mb12" style="padding:11px 14px"><div class="row fs12"><span class="spinner"></span><span>查重执行中…</span></div></div>` : ''}
      ${data ? `<div class="grid c4" style="align-items:start">
        <div class="kpi ${over ? 'warn' : 'jade'}">
          <div class="k-label">最高相似度</div>
          <div class="k-value" style="color:${over ? 'var(--danger)' : 'var(--jade)'}">${pct}<small>%</small></div>
          <div class="k-foot">阈值 ${Math.round(threshold * 100)}% · ${over ? '存在重复风险' : '低于阈值'}</div>
        </div>
        <div class="kpi">
          <div class="k-label">超阈值重复对</div>
          <div class="k-value">${stats.over_threshold ?? (data.pairs || []).filter((pair) => Number(pair.score ?? pair.similarity) >= threshold).length}<small>组</small></div>
          <div class="k-foot">共 ${(data.pairs || []).length} 组重复对</div>
        </div>
        <div class="kpi">
          <div class="k-label">比对章节</div>
          <div class="k-value">${stats.chapters ?? '—'}<small>节</small></div>
          <div class="k-foot">两两比对 ${(data.pairs || []).length} 组命中</div>
        </div>
        <div class="kpi">
          <div class="k-label">最近检查</div>
          <div class="k-value" style="font-size:16px;line-height:1.5">${escapeHtml(data.checked_at ? fmtDateTime(data.checked_at) : '—')}</div>
          <div class="k-foot">阈值来自设置 · 质量与查重阈值</div>
        </div>
      </div>
      <div class="card mt12">
        <div class="card-title">Top 重复对 <span class="right fs11 muted">按相似度降序</span></div>
        <div class="mt12">${pairsMarkup(data, threshold)}</div>
        ${data.summary ? `<div class="hint mt8">${escapeHtml(String(data.summary))}</div>` : ''}
      </div>`
    : `<div class="card">${emptyState('尚未执行查重', '生成正文后可执行章节两两比对', '⧉')}
        <div class="row" style="justify-content:center"><button class="btn primary sm" data-run>开始查重</button></div></div>`}`;

    const button = container.querySelector('[data-run]');
    if (button) {
      button.onclick = async () => {
        if (busy) return;
        const hasContent = Object.keys(host.plan.chapters || {}).length > 0;
        if (!hasContent) {
          toast('请先生成正文', '查重需要已生成的章节内容', 'warn');
          return;
        }
        busy = true;
        paint();
        try {
          await host.trigger('duplicate');
          if (disposed) return;
          toast('查重完成', '', 'ok');
          await host.reload();
        } catch (error) {
          if (disposed) return;
          toast('查重失败', error?.message || String(error), 'bad');
          busy = false;
          paint();
        }
      };
    }
  }

  paint();
  return { refresh() { paint(); }, destroy() { disposed = true; } };
}
