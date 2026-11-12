// 招标解析：左侧需求条目表（可筛选）+ 右侧招标原文（点条目定位原文）
import { api } from '../../lib/api.js';
import { $, escapeHtml, fmtRelative, markdown, pill, emptyState, loading, toast } from '../../lib/ui.js';
import { CAT_KIND, categoryLabel } from './data.js';

const TENDER_CACHE = new Map();

async function loadTender(pid) {
  if (TENDER_CACHE.has(pid)) return TENDER_CACHE.get(pid);
  const data = await api.tender(pid).catch(() => ({ text: '', name: '' }));
  const value = { text: String(data?.text || ''), name: String(data?.name || '招标文件') };
  TENDER_CACHE.set(pid, value);
  return value;
}

function highlight(rootNode, requirement) {
  for (const mark of rootNode.querySelectorAll('mark.hl-hit')) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  }
  const sourceRef = String(requirement.sourceRef || '').replace(/^#+\s*/, '').trim();
  const candidates = [requirement.text.slice(0, 22), requirement.text.slice(0, 12), sourceRef, requirement.anchorHeading].filter((item) => item && String(item).length > 3);
  for (const needle of candidates) {
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const index = node.nodeValue.indexOf(needle);
      if (index >= 0) {
        try {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + needle.length);
          const mark = document.createElement('mark');
          mark.className = 'hl-hit';
          range.surroundContents(mark);
          mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
          return true;
        } catch { /* 跨节点跳过 */ }
      }
      node = walker.nextNode();
    }
  }
  return false;
}

export default async function mount(container, host) {
  let disposed = false;
  let filter = 'all';
  let selectedId = null;
  let tender = { text: '', name: '招标文件' };
  let busy = false;
  let task = null;

  const reqs = () => host.plan.requirements;

  function filtered() {
    const list = reqs();
    if (filter === 'all') return list;
    return list.filter((item) => item.category === filter || (filter === 'veto' && item.veto));
  }

  function summary() {
    const list = reqs();
    const count = (category) => list.filter((item) => item.category === category).length;
    return {
      total: list.length,
      technical: count('technical'),
      qualification: count('qualification'),
      commercial: count('commercial'),
      veto: list.filter((item) => item.veto).length,
    };
  }

  function progressMarkup() {
    if (!busy && !task) return '';
    const progress = Number(task?.progress ?? 0);
    const status = task?.status === 'error' ? '任务失败' : task ? `执行中 ${progress}%` : '任务提交中…';
    const lastLog = task?.logs?.at?.(-1) || '';
    return `<div class="card bg-soft mb12" style="padding:11px 14px">
      <div class="row fs12"><span class="spinner"></span><span>${escapeHtml(status)}</span>
        <span class="muted right ellipsis">${escapeHtml(lastLog)}</span></div>
      <div class="bar mt8"><i style="width:${Math.max(3, Math.min(100, progress))}%"></i></div>
    </div>`;
  }

  function tableMarkup() {
    const list = filtered();
    if (!reqs().length) {
      return emptyState('尚未解析招标文件', '点击右上角「重新解析」，由解析 Agent 抽取要求条目', '⌕');
    }
    if (!list.length) return emptyState('该类别下没有条目', '切换上方筛选试试', '⌕');
    return `<div class="table-wrap" style="max-height:calc(100vh - 330px)">
      <table class="table compact" style="table-layout:fixed">
        <colgroup><col style="width:60px"><col style="width:54px"><col><col style="width:40px"><col style="width:38px"><col style="width:72px"></colgroup>
        <thead><tr><th>编号</th><th>类别</th><th>要求文本</th><th>废标</th><th class="num">权重</th><th>响应</th></tr></thead>
        <tbody>
          ${list.map((item) => {
    const responded = Boolean(item.response || item.deviationResponse);
    return `<tr class="clickable ${item.id === selectedId ? 'selected' : ''}" data-req="${escapeHtml(item.id)}">
            <td class="mono fs11 ellipsis" title="${escapeHtml(item.id)}">${escapeHtml(item.id)}</td>
            <td>${pill(item.categoryLabel, CAT_KIND[item.category] || '')}</td>
            <td style="overflow-wrap:anywhere">${escapeHtml(item.text)}</td>
            <td>${item.veto ? `<span class="pill bad" title="废标条款">废</span>` : '<span class="muted fs11">—</span>'}</td>
            <td class="num">${item.weight === null || item.weight === undefined ? '—' : escapeHtml(String(item.weight))}</td>
            <td title="${escapeHtml(item.response || item.deviationResponse || '尚未响应')}">${responded ? pill('已', 'ok') : pill('待', 'plain')}</td>
          </tr>`;
  }).join('')}
        </tbody>
      </table>
    </div>`;
  }

  function paint() {
    if (disposed) return;
    const stat = summary();
    const categories = ['all', 'qualification', 'technical', 'commercial', 'scoring', 'veto'];
    container.innerHTML = `
      <div class="row wrap mb12" style="gap:10px">
        <div class="fs12 muted">要求 <b class="ink num">${stat.total}</b> 条 · 技术 ${stat.technical} · 资格 ${stat.qualification} · 商务 ${stat.commercial} · 废标项 ${stat.veto}</div>
        <div class="right row" style="gap:8px">
          <span class="pill plain">${escapeHtml(tender.name)}</span>
          <button class="btn primary sm" id="td-reparse" ${busy ? 'disabled' : ''}>重新解析</button>
        </div>
      </div>
      ${progressMarkup()}
      <div class="wb-split-wide">
        <div class="card flush">
          <div class="card-head" style="padding:10px 12px">
            <div class="segmented">
              ${categories.map((key) => `<button data-filter="${key}" class="${filter === key ? 'active' : ''}">${key === 'all' ? '全部' : categoryLabel(key)}</button>`).join('')}
            </div>
          </div>
          <div id="td-table">${tableMarkup()}</div>
        </div>
        <div class="wb-doc wb-pane" id="td-doc">
          ${tender.text ? `<div class="md">${markdown(tender.text)}</div>` : emptyState('招标原文为空', '请在项目管理中粘贴招标文件全文', '▤')}
        </div>
      </div>`;

    const reparse = $('#td-reparse', container);
    if (reparse) {
      reparse.onclick = async () => {
        if (busy) return;
        busy = true;
        task = null;
        paint();
        try {
          await host.trigger('parse', { onTick: (next) => { task = next; if (!disposed) paint(); } });
          if (disposed) return;
          toast('招标解析完成', `共 ${reqs().length} 条要求`, 'ok');
          TENDER_CACHE.delete(host.pid);
          await host.reload();
        } catch (error) {
          if (disposed) return;
          toast('解析失败', error?.message || String(error), 'bad');
          busy = false;
          task = null;
          paint();
        }
      };
    }

    for (const node of container.querySelectorAll('[data-filter]')) {
      node.onclick = () => { filter = node.dataset.filter; paint(); };
    }
    for (const node of container.querySelectorAll('[data-req]')) {
      node.onclick = () => {
        selectedId = node.dataset.req;
        for (const row of container.querySelectorAll('[data-req]')) row.classList.toggle('selected', row.dataset.req === selectedId);
        const requirement = reqs().find((item) => item.id === selectedId);
        const doc = $('#td-doc', container);
        if (requirement && doc) {
          const hit = highlight(doc, requirement);
          if (!hit) toast('原文中未定位到对应段落', '可能来自清洗后的解析结果', 'warn');
        }
      };
    }
  }

  container.innerHTML = loading('读取招标文件…');
  tender = await loadTender(host.pid).catch(() => ({ text: '', name: '招标文件' }));
  if (disposed) return null;
  paint();

  return { refresh: paint, destroy() { disposed = true; } };
}




