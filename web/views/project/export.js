// 导出：前置校验清单（不通过禁用导出）+ 生成 Word + 导出历史
import { api } from '../../lib/api.js';
import {
  escapeHtml, fmtBytes, fmtDateTime, pill, emptyState, toast,
} from '../../lib/ui.js';
import { chapterWordTotal, isMissing, recordLocalExport } from './data.js';

const PLACEHOLDER = /(待补充|待确认|待填写|TODO|TBD|XXX|xx%|【\s*】|＿{2,})/g;

function placeholderHits(text) {
  const hits = [];
  for (const match of String(text || '').matchAll(PLACEHOLDER)) {
    const start = Math.max(0, (match.index || 0) - 14);
    hits.push({ word: match[0], context: String(text).slice(start, (match.index || 0) + match[0].length + 16).replace(/\s+/g, ' ') });
  }
  return hits;
}

export default async function mount(container, host) {
  let disposed = false;
  let busy = false;

  function preflight() {
    const plan = host.plan;
    const words = chapterWordTotal(plan);
    const text = Object.values(plan.chapters || {}).map((chapter) => chapter.content || '').join('\n');
    const hits = placeholderHits(text);
    const rejection = host.checks.rejection || null;
    const vetoes = rejection?.vetoes || rejection?.items || [];
    const unresponded = rejection?.summary?.veto_unresponded
      ?? (Array.isArray(vetoes) && vetoes.length ? vetoes.filter((item) => !item.responded).length : null);
    const confirmed = host.deviation.status === 'confirmed' || host.deviation.status === 'confirmed-local';
    return [
      {
        key: 'parse', label: '招标解析完成', ok: plan.requirements.length > 0,
        detail: plan.requirements.length ? `${plan.requirements.length} 条要求` : '尚未解析', tab: 'tender',
      },
      {
        key: 'content', label: '技术方案正文', ok: words > 0,
        detail: words > 0 ? `${plan.flatNodes.length} 节 · ${words} 字` : '尚未生成正文', tab: 'plan',
      },
      {
        key: 'deviation', label: '响应偏离表已确认', ok: confirmed,
        detail: host.deviation.status === 'confirmed' ? '服务端已确认'
          : host.deviation.status === 'confirmed-local' ? '本地记录已确认' : '未确认（导出将阻断）', tab: 'deviation',
      },
      {
        key: 'rejection', label: '废标条款全部响应', ok: rejection ? unresponded === 0 : false,
        detail: !rejection ? '尚未执行废标检查' : unresponded ? `${unresponded} 条未响应` : '全部已响应', tab: 'rejection',
      },
      {
        key: 'placeholder', label: '无占位符 / 待补充标记', ok: words > 0 && hits.length === 0,
        detail: !words ? '无正文可校验' : hits.length ? `发现 ${hits.length} 处待补充标记` : '通过', tab: 'plan',
      },
    ].map((item) => ({ ...item, hits: item.key === 'placeholder' ? hits.slice(0, 3) : [] }));
  }

  function historyMarkup() {
    const items = host.exports.items || [];
    if (!items.length) return emptyState('尚无导出记录', '校验通过后生成 Word，历史会记录文件名、大小与校验状态', '▤');
    return `<div class="table-wrap" style="max-height:300px">
      <table class="table compact">
        <thead><tr><th>文件名</th><th class="num">大小</th><th>生成时间</th><th>校验</th><th></th></tr></thead>
        <tbody>${items.map((item) => `<tr>
          <td class="ellipsis" style="max-width:280px">${escapeHtml(item.fileName || '-')}</td>
          <td class="num">${escapeHtml(fmtBytes(item.bytes))}</td>
          <td class="nowrap">${escapeHtml(fmtDateTime(item.createdAt))}</td>
          <td>${item.validation && item.validation.ok === false ? pill('未通过', 'bad') : pill('通过', 'ok')}</td>
          <td class="col-tight">${item.downloadUrl
    ? `<a class="btn xs" href="${escapeHtml(item.downloadUrl)}" download>下载</a>`
    : '<span class="muted fs11">—</span>'}</td>
        </tr>`).join('')}</tbody>
      </table></div>`;
  }

  function paint() {
    if (disposed) return;
    const items = preflight();
    const blockers = items.filter((item) => !item.ok);
    const ready = blockers.length === 0;

    container.innerHTML = `
      <div class="row wrap mb12" style="gap:10px">
        <div class="fs12 muted">导出前逐项校验：任一未通过都会阻断导出，避免把废标风险带进正式文件。</div>
        <div class="right row" style="gap:6px">
          ${ready ? pill('校验通过', 'ok') : pill(`${blockers.length} 项待处理`, 'bad')}
          <button class="btn primary sm" id="ex-run" ${ready && !busy ? '' : 'disabled'}>${busy ? '生成中…' : '生成 Word'}</button>
        </div>
      </div>

      <div class="grid c2" style="align-items:start">
        <div class="card">
          <div class="card-title">前置校验清单 <span class="right fs11 muted">${items.filter((item) => item.ok).length}/${items.length} 通过</span></div>
          <div class="mt12 stack" style="gap:0">
            ${items.map((item) => `<div class="ex-check ${item.ok ? 'ok' : 'bad'}">
              <span class="ex-mark">${item.ok ? '✓' : '✕'}</span>
              <div class="grow">
                <div class="ex-label">${escapeHtml(item.label)}</div>
                <div class="ex-detail">${escapeHtml(item.detail)}</div>
                ${item.hits.length ? `<ul class="ex-hits">${item.hits.map((hit) => `<li><code>${escapeHtml(hit.word)}</code> ${escapeHtml(hit.context)}</li>`).join('')}</ul>` : ''}
              </div>
              <button class="btn xs" data-goto="${item.tab}">前往</button>
            </div>`).join('')}
          </div>
          ${ready ? `<div class="wb-banner mt12"><i>◆</i><span>全部校验通过。生成的 .docx 会出现在右侧历史中，可直接下载交付。</span></div>`
    : `<div class="wb-banner bad mt12"><i>▲</i><span>存在未通过项，导出被阻断。按清单逐项处理后按钮会自动可用。</span></div>`}
        </div>

        <div class="card flush">
          <div class="card-head"><div class="card-title">导出历史</div>
            <span class="right fs11 muted">${host.exports.source === 'local' ? '本地记录（导出接口未实现时）' : '服务端导出记录'}</span></div>
          ${historyMarkup()}
          <div class="card-foot">
            <span class="fs11 muted">文件为 Word（.docx），由文档生成 Agent 合并章节并校验编号。</span>
            <a class="btn sm ghost right" href="#/run/${escapeHtml(String(host.ws?.latestRun?.run?.id || ''))}">查看运行产物</a>
          </div>
        </div>
      </div>`;

    for (const node of container.querySelectorAll('[data-goto]')) {
      node.onclick = () => host.switchTab(node.dataset.goto);
    }

    const runButton = document.querySelector('#ex-run', container);
    if (runButton) {
      runButton.onclick = async () => {
        if (busy) return;
        busy = true;
        paint();
        let result = null;
        let mode = 'api';
        try {
          result = await api.exportProject(host.pid, {});
        } catch (error) {
          if (!isMissing(error)) {
            if (!disposed) {
              toast(error?.status === 409 ? '导出被阻断' : '导出失败', error?.message || String(error), error?.status === 409 ? 'warn' : 'bad');
              busy = false;
              await host.reload().catch(() => {});
            }
            return;
          }
          mode = 'compat';
          try {
            result = await api.exportDocx(host.pid);
          } catch (inner) {
            if (!disposed) {
              toast('导出失败', inner?.message || String(inner), 'bad');
              busy = false;
              paint();
            }
            return;
          }
        }
        if (disposed) return;
        const rawUrl = result?.download_url || result?.file || (result?.file_name ? `/files/${result.file_name}` : '');
        const fileName = String(result?.file_name || result?.file || '').split('/').filter(Boolean).pop()
          || `bidcore-${host.pid}.docx`;
        const entry = {
          id: `local-${Date.now()}`,
          fileName,
          bytes: Number(result?.size || result?.bytes || 0),
          createdAt: new Date().toISOString(),
          downloadUrl: rawUrl,
          validation: result?.validation || { ok: true },
        };
        if (host.exports.source !== 'api') recordLocalExport(host.pid, entry);
        toast('Word 已生成', mode === 'compat' ? `${fileName}（兼容导出接口）` : fileName, rawUrl ? 'ok' : 'warn');
        busy = false;
        await host.reload();
        if (disposed) return;
        if (rawUrl) {
          const link = document.createElement('a');
          link.href = rawUrl;
          link.download = fileName;
          link.rel = 'noopener';
          document.body.appendChild(link);
          link.click();
          link.remove();
        }
      };
    }
  }

  paint();
  return { refresh() { paint(); }, destroy() { disposed = true; } };
}

