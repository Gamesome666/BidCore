// 技术方案：左侧目录树 + 右侧 Markdown 编辑器 / 全局事实表；顶部步骤条与三个单步按钮
import {
  $, escapeHtml, markdown, pill, emptyState, toast, wordCount, fmtDateTime, confirmDialog,
} from '../../lib/ui.js';
import { api } from '../../lib/api.js';
import {
  stepStates, STEP_META, saveChapter, chapterWordTotal,
} from './data.js';

const SELECTED = new Map();
const PANEL = new Map();

const STEPS = ['parse', 'outline', 'facts', 'content'];

export default async function mount(container, host) {
  let disposed = false;
  let busy = false;
  let task = null;
  let panel = PANEL.get(host.pid) || 'content';
  let preview = false;
  let selectedId = SELECTED.get(host.pid) || null;

  const plan = () => host.plan;
  const nodes = () => plan().flatNodes;
  const current = () => nodes().find((node) => node.id === selectedId) || nodes()[0] || null;
  // 默认选中第一节已生成正文的章节（父节点通常没有正文）
  if (!selectedId || !nodes().some((node) => node.id === selectedId)) {
    const withContent = nodes().find((node) => (plan().chapters[node.id]?.content || '').length > 0);
    selectedId = withContent?.id || nodes()[0]?.id || null;
    if (selectedId) SELECTED.set(host.pid, selectedId);
  }
  const savedContent = (node) => (node ? plan().chapters[node.id]?.content || '' : '');

  function stepsMarkup() {
    const states = stepStates(plan(), host.exports.items.length).filter((step) => STEPS.includes(step.key));
    return `<div class="steps">
      ${states.map((step) => `<div class="step ${step.done ? 'done' : ''} ${step.active ? 'active' : ''}" title="${escapeHtml(STEP_META[step.key].desc)}">
        <span class="s-idx">${step.done ? '✓' : String(step.index).padStart(2, '0')}</span>
        <span class="s-label">${escapeHtml(step.label)}</span>
      </div>`).join('')}
    </div>`;
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

  function treeMarkup() {
    const list = nodes();
    if (!list.length) return emptyState('尚无目录', '先生成目录，或从招标解析开始', '▤');
    return `<div class="list" style="gap:2px">${list.map((node) => {
      const chapter = plan().chapters[node.id];
      const words = chapter?.words || 0;
      const statusPill = chapter?.content
        ? pill(chapter.local ? '本地草稿' : '已生成', chapter.local ? 'warn' : 'ok')
        : node.status === 'running' ? pill('生成中', 'info') : pill('未生成', 'plain');
      return `<div class="wb-tree-row ${node.id === current()?.id ? 'active' : ''}" data-node="${escapeHtml(node.id)}" style="margin-left:${(node.level - 1) * 14}px">
        <span class="t-no">${escapeHtml(node.no || '')}</span>
        <span class="t-title">${escapeHtml(node.title)}</span>
        <span class="t-words">${words ? `${words} 字` : ''}</span>
        ${statusPill}
      </div>`;
    }).join('')}</div>`;
  }

  function factsMarkup() {
    const facts = plan().facts || [];
    return `<div class="card">
      <div class="card-title">全局事实
        <span class="right row" style="gap:6px">
          ${plan().factsLocal ? '<span class="pill warn">本地推导</span>' : '<span class="pill ok">已生成</span>'}
          <button class="btn xs" data-run="facts">${plan().factsLocal ? '重新推导' : '生成'}</button>
        </span>
      </div>
      ${plan().factsLocal ? `<div class="wb-banner mt8"><i>◆</i><span>全局事实接口未实现，当前取值由招标解析结果推导（来源列已标注），用于正文引用占位。</span></div>` : ''}
      ${facts.length ? `<div class="table-wrap mt8" style="max-height:calc(100vh - 380px)">
        <table class="table compact">
          <thead><tr><th style="width:150px">事实</th><th>取值</th><th style="width:190px">来源</th></tr></thead>
          <tbody>${facts.map((fact) => `<tr>
            <td class="fw6">${escapeHtml(fact.key)}</td>
            <td>${escapeHtml(fact.value)}</td>
            <td class="muted fs11">${escapeHtml(fact.source || '—')}</td>
          </tr>`).join('')}</tbody>
        </table></div>` : emptyState('尚无全局事实', '解析完成后可生成项目事实，正文引用会更稳定', '▦')}
    </div>`;
  }

  function editorMarkup() {
    const node = current();
    if (!node) return `<div class="card">${emptyState('请选择左侧章节', '目录生成后在这里写作与预览', '✎')}</div>`;
    const chapter = plan().chapters[node.id];
    const content = chapter?.content || '';
    const index = nodes().findIndex((item) => item.id === node.id);
    return `<div class="card">
      <div class="card-head" style="border-bottom:0;padding:0 0 10px">
        <div style="min-width:0">
          <div class="card-title">${escapeHtml(node.no ? `${node.no} ` : '')}${escapeHtml(node.title)}</div>
          <div class="card-sub">
            ${chapter?.local ? pill('本地草稿', 'warn') : chapter?.content ? pill('已生成', 'ok') : pill('未生成', 'plain')}
            <span class="ml8">${escapeHtml(String(content ? wordCount(content) : 0))} 字</span>
            ${node.targetWords ? `<span class="ml8">目标 ${escapeHtml(String(node.targetWords))} 字</span>` : ''}
            ${chapter?.updatedAt ? `<span class="ml8">保存于 ${escapeHtml(fmtDateTime(chapter.updatedAt))}</span>` : ''}
          </div>
        </div>
        <div class="right row" style="gap:6px">
          <div class="segmented">
            <button data-mode="edit" class="${preview ? '' : 'active'}">编辑</button>
            <button data-mode="preview" class="${preview ? 'active' : ''}">预览</button>
          </div>
          <button class="btn xs" data-prev ${index <= 0 ? 'disabled' : ''}>上一节</button>
          <button class="btn xs" data-next ${index >= nodes().length - 1 ? 'disabled' : ''}>下一节</button>
          <button class="btn sm accent" data-ai title="调用真实模型（deepseek-v4.1-flash）按招标要求重写本节">✦ AI 生成本节</button>
          <button class="btn primary sm" data-save>保存</button>
        </div>
      </div>
      ${preview
    ? `<div class="wb-doc" style="padding:18px 22px;min-height:420px"><div class="md">${content ? markdown(content) : '<p class="hint">该章节还没有内容</p>'}</div></div>`
    : `<textarea class="wb-editor" id="wp-editor" spellcheck="false" placeholder="在此撰写本章节 Markdown 正文；支持标题、列表、表格与来源标注">${escapeHtml(content)}</textarea>
        <div class="row mt8 fs11 muted"><span id="wp-count">${escapeHtml(String(wordCount(content)))} 字</span>
          <span>· 切换章节会自动保存未提交的修改</span>
          <span class="right">共 ${escapeHtml(String(chapterWordTotal(plan())))} 字</span></div>`}
    </div>`;
  }

  function paint() {
    if (disposed) return;
    const list = nodes();
    container.innerHTML = `
      <div class="mb12">${stepsMarkup()}</div>
      <div class="row wrap mb12" style="gap:6px;justify-content:flex-end">
        <button class="btn sm" data-run="outline" ${busy ? 'disabled' : ''}>生成目录</button>
        <button class="btn sm" data-run="facts" ${busy ? 'disabled' : ''}>生成全局事实</button>
        <button class="btn primary sm" data-run="content" ${busy ? 'disabled' : ''}>生成正文</button>
      </div>
      ${progressMarkup()}
      ${plan().source === 'compat' ? `<div class="wb-banner mb12"><i>◆</i><span>当前读取兼容接口 /api/technical-plan 的项目状态：目录与章节保存走<code> tasks/start-* </code>任务；章节正文保存落本地草稿（新接口未实现）。</span></div>` : ''}
      <div class="wb-split-editor">
        <div class="card flush wb-pane" style="max-height:calc(100vh - 300px)">
          <div class="card-head" style="padding:10px 12px">
            <div class="card-title">目录 <span class="right fs11 muted">${list.length} 节 · ${chapterWordTotal(plan())} 字</span></div>
          </div>
          <div class="pad-sm" id="wp-tree">${treeMarkup()}</div>
        </div>
        <div>
          <div class="segmented mb12">
            <button data-panel="content" class="${panel === 'content' ? 'active' : ''}">正文编辑</button>
            <button data-panel="facts" class="${panel === 'facts' ? 'active' : ''}">全局事实</button>
          </div>
          ${panel === 'content' ? (list.length ? editorMarkup() : `<div class="card">${emptyState('尚无目录', '先点击「生成目录」，目录由评分办法与技术条款映射得到', '▤')}
            <div class="row" style="justify-content:center"><button class="btn primary sm" data-run="outline">生成目录</button></div></div>`) : factsMarkup()}
        </div>
      </div>`;

    const editor = $('#wp-editor', container);
    if (editor) {
      editor.addEventListener('input', () => {
        const counter = $('#wp-count', container);
        if (counter) counter.textContent = `${wordCount(editor.value)} 字`;
      });
      editor.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          saveCurrent();
        }
      });
    }

    for (const node of container.querySelectorAll('[data-node]')) {
      node.onclick = async () => {
        if (node.dataset.node === current()?.id) return;
        await saveCurrent({ silent: true });
        selectedId = node.dataset.node;
        SELECTED.set(host.pid, selectedId);
        paint();
      };
    }
    for (const node of container.querySelectorAll('[data-mode]')) {
      node.onclick = () => { preview = node.dataset.mode === 'preview'; paint(); };
    }
    for (const node of container.querySelectorAll('[data-panel]')) {
      node.onclick = () => { panel = node.dataset.panel; PANEL.set(host.pid, panel); paint(); };
    }
    for (const node of container.querySelectorAll('[data-run]')) {
      node.onclick = () => runStep(node.dataset.run);
    }
    const save = container.querySelector('[data-save]');
    if (save) save.onclick = () => saveCurrent();
    const ai = container.querySelector('[data-ai]');
    if (ai) ai.onclick = () => aiGenerate(ai);
    const prev = container.querySelector('[data-prev]');
    if (prev) prev.onclick = () => stepNode(-1);
    const next = container.querySelector('[data-next]');
    if (next) next.onclick = () => stepNode(1);
  }

  async function saveCurrent({ silent = false } = {}) {
    const node = current();
    const editor = $('#wp-editor', container);
    if (!node || !editor) return;
    const text = editor.value;
    if (text === savedContent(node)) {
      if (!silent) toast('内容未变化', '', 'warn');
      return;
    }
    try {
      const result = await saveChapter(host.pid, node.id, text);
      if (!silent) {
        toast(result.mode === 'local' ? '已保存到本地草稿' : '章节已保存',
          result.mode === 'local' ? '章节正文接口未实现，草稿仅存于本机浏览器' : '', result.mode === 'local' ? 'warn' : 'ok');
      }
      await host.reload();
    } catch (error) {
      toast('保存失败', error?.message || String(error), 'bad');
    }
  }

  /** 调用真实模型重写本节：只在人工点击时发生，失败自动回退确定性正文 */
  async function aiGenerate(button) {
    const node = current();
    const editor = $('#wp-editor', container);
    if (!node || !editor) return;
    if (editor.value !== savedContent(node)) {
      const ok = await confirmDialog('当前章节有未保存修改，AI 生成会覆盖编辑框内容。继续？');
      if (!ok) return;
    }
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'AI 写作中…';
    try {
      const result = await api.aiChapter(host.pid, node.id);
      const info = result.llm || {};
      toast(info.used ? 'AI 已生成本节' : '模型未启用，已用确定性正文',
        `${result.words} 字 · ${info.model || ''}${info.ms ? ` · ${(info.ms / 1000).toFixed(1)}s` : ''}`,
        info.used ? 'ok' : 'warn');
      await host.reload();
    } catch (error) {
      toast('AI 生成失败', error?.message || String(error), 'bad');
      button.disabled = false;
      button.textContent = label;
    }
  }

  async function stepNode(delta) {    const list = nodes();
    const index = list.findIndex((node) => node.id === current()?.id);
    const target = list[index + delta];
    if (!target) return;
    await saveCurrent({ silent: true });
    selectedId = target.id;
    SELECTED.set(host.pid, selectedId);
    paint();
  }

  async function runStep(step) {
    if (busy) return;
    if (step === 'outline' && !plan().requirements.length) { toast('请先完成招标解析', '目录由解析出的评分办法与技术条款映射', 'warn'); return; }
    if (step === 'facts' && !plan().requirements.length) { toast('请先完成招标解析', '全局事实由项目元信息与解析统计推导', 'warn'); return; }
    if (step === 'content' && !nodes().length) { toast('请先生成目录', '', 'warn'); return; }
    busy = true;
    task = null;
    paint();
    try {
      const result = await host.trigger(step, { onTick: (next) => { task = next; if (!disposed) paint(); } });
      if (disposed) return;
      const label = STEP_META[step].label;
      if (step === 'facts' && result.mode === 'local') {
        toast('已推导全局事实', '事实接口未实现，取值来自招标解析结果（标注为本地推导）', 'warn');
      } else if (result.mode === 'compat') {
        toast(`${label}完成`, '经兼容任务接口执行', 'ok');
      } else {
        toast(`${label}完成`, '', 'ok');
      }
      await host.reload();
    } catch (error) {
      if (disposed) return;
      toast('执行失败', error?.message || String(error), 'bad');
      busy = false;
      task = null;
      paint();
    }
  }

  paint();
  return {
    refresh() { paint(); },
    destroy() { disposed = true; },
  };
}


