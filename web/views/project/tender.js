// 招标解析：左侧需求条目表（可筛选）+ 右侧招标原文（点条目定位原文）
import { api } from '../../lib/api.js';
import { $, escapeHtml, fmtRelative, markdown, pill, emptyState, loading, toast, modal } from '../../lib/ui.js';
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

  /** 跑一次招标解析（上传后 / 手动重新解析共用），带进度回调 */
  async function runParse() {
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
  }

  /** 粘贴招标正文（扫描件 OCR 后 / 从别处复制文本时的兜底） */
  function openPaste() {
    if (busy) return;
    const box = modal({
      title: '粘贴招标正文',
      wide: true,
      body: `<div class="field">
          <label>招标正文（Markdown 或纯文本均可，至少 200 字）</label>
          <textarea class="textarea" id="td-paste-text" style="min-height:320px" placeholder="把招标文件正文粘贴到这里；扫描件可先用 OCR 工具转成文字">${escapeHtml(tender.text || '')}</textarea>
          <div class="hint">保存后会立刻重新解析，替换当前招标正文。</div>
        </div>`,
      footer: '<button class="btn" data-modal-close>取消</button><button class="btn primary" id="td-paste-save">保存并解析</button>',
    });
    const save = $('#td-paste-save', box.root);
    save.onclick = async () => {
      const text = $('#td-paste-text', box.root).value.trim();
      if (text.length < 200) { toast('正文太短', '至少需要 200 字', 'warn'); return; }
      save.disabled = true;
      save.textContent = '保存中…';
      try {
        await api.saveTenderText(host.pid, text);
        box.close();
        TENDER_CACHE.delete(host.pid);
        tender = await loadTender(host.pid).catch(() => ({ text, name: '招标正文（粘贴）' }));
        toast('招标正文已保存', `${text.length} 字`, 'ok');
        await runParse();
      } catch (error) {
        save.disabled = false;
        save.textContent = '保存并解析';
        toast('保存失败', error?.message || String(error), 'bad');
      }
    };
  }

  /** 上传招标文件（docx/doc/wps/pdf/md/txt）→ 落库 → 自动解析 */
  async function uploadTenderFile(file) {
    if (busy) return;
    if (!/\.(docx|doc|wps|pdf|md|txt)$/i.test(file.name)) {
      toast('格式不支持', '请上传 docx / doc / wps / pdf / md / txt', 'warn');
      return;
    }
    if (file.size > 25 * 1024 * 1024) {
      toast('文件过大', '招标文件需小于 25MB', 'bad');
      return;
    }
    busy = true;
    task = null;
    paint();
    try {
      const result = await api.uploadTender(host.pid, file);
      TENDER_CACHE.delete(host.pid);
      tender = await loadTender(host.pid).catch(() => ({ text: '', name: result.file }));
      toast('招标文件已上传', `${result.file} · ${result.chars} 字${result.pages ? ` · ${result.pages} 页` : ''}`, 'ok');
      await runParse();
    } catch (error) {
      busy = false;
      task = null;
      paint();
      toast('上传失败', error?.message || String(error), 'bad');
    }
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
          <button class="btn sm" id="td-paste" ${busy ? 'disabled' : ''}>粘贴正文</button>
          <button class="btn sm" id="td-upload" ${busy ? 'disabled' : ''}>上传招标文件</button>
          <input type="file" id="td-file" accept=".docx,.doc,.wps,.pdf,.md,.txt" hidden />
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
          ${tender.text ? `<div class="md">${markdown(tender.text)}</div>` : emptyState('招标原文为空', '点击右上角「上传招标文件」（docx / pdf），或直接在项目管理里粘贴正文', '▤')}
        </div>
      </div>`;

    const fileInput = $('#td-file', container);
    const uploadBtn = $('#td-upload', container);
    if (uploadBtn && fileInput) {
      uploadBtn.onclick = () => fileInput.click();
      fileInput.onchange = () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (file) void uploadTenderFile(file);
      };
    }

    const pasteBtn = $('#td-paste', container);
    if (pasteBtn) pasteBtn.onclick = () => openPaste();

    const reparse = $('#td-reparse', container);
    if (reparse) reparse.onclick = () => { void runParse(); };

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

  // 拖拽上传：整块页签都能投递（只绑一次，paint 不重复绑定）
  if (!container.dataset.tenderDrop) {
    container.dataset.tenderDrop = '1';
    const highlight = (on) => {
      container.style.outline = on ? '2px dashed var(--accent)' : '';
      container.style.outlineOffset = on ? '-6px' : '';
    };
    container.addEventListener('dragover', (event) => {
      if (!event.dataTransfer || ![...(event.dataTransfer.types || [])].includes('Files')) return;
      event.preventDefault();
      highlight(true);
    });
    container.addEventListener('dragleave', () => highlight(false));
    container.addEventListener('drop', (event) => {
      highlight(false);
      const file = event.dataTransfer?.files?.[0];
      if (!file) return;
      event.preventDefault();
      void uploadTenderFile(file);
    });
  }

  container.innerHTML = loading('读取招标文件…');
  tender = await loadTender(host.pid).catch(() => ({ text: '', name: '招标文件' }));
  if (disposed) return null;
  paint();

  return { refresh: paint, destroy() { disposed = true; } };
}




