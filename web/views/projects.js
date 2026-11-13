// 项目管理：项目卡网格 + 搜索 + 新建项目（可粘贴招标文件全文）
import { api } from '../lib/api.js';
import {
  $, $$, escapeHtml, fmtDate, fmtRelative, countdown, pill, statusPill,
  toast, emptyState, debounce, modal, confirmDialog, loading,
} from '../lib/ui.js';

const STYLE = `
<style>
  .pj-head { display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 18px; }
  .pj-eyebrow { font-size: 10.5px; letter-spacing: .2em; text-transform: uppercase; color: var(--accent); font-weight: 700; margin-bottom: 4px; }
  .pj-title { font-family: var(--serif); font-size: 28px; line-height: 1.2; color: var(--ink); font-weight: 600; }
  .pj-desc { font-size: 12.5px; color: var(--muted); margin-top: 6px; max-width: 720px; }
  .pj-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .pj-search { display: flex; align-items: center; gap: 6px; background: var(--card); border: 1px solid var(--line-strong); border-radius: var(--radius-sm); padding: 0 8px; height: 34px; }
  .pj-search span { color: var(--muted); font-size: 13px; }
  .pj-search .input { border: 0; box-shadow: none; width: 210px; padding: 0; height: 30px; background: transparent; }
  .pj-search .input:focus { box-shadow: none; }
  .pj-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; }
  .project-card { gap: 11px; }
  .project-card .p-name { line-height: 1.42; }
  .pj-new-tile { border: 1px dashed var(--line-strong); background: transparent; border-radius: var(--radius); min-height: 172px; display: grid; place-items: center; color: var(--muted); cursor: pointer; font-size: 12.5px; transition: all .12s; }
  .pj-new-tile:hover { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .pj-new-tile b { display: block; font-size: 20px; line-height: 1; text-align: center; margin-bottom: 7px; font-weight: 400; }
  .project-card .p-facts { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; font-size: 11.5px; color: var(--muted); }
  .project-card .p-facts b { color: var(--ink-2); font-weight: 550; font-variant-numeric: tabular-nums; }
  .project-card .p-run { display: flex; align-items: center; gap: 7px; font-size: 11.5px; color: var(--muted); padding-top: 9px; border-top: 1px dashed var(--line); }
  .project-card .p-foot { padding-top: 9px; }
  .project-card .p-flag { position: absolute; top: 0; left: 0; width: 3px; height: 100%; border-radius: 10px 0 0 10px; background: transparent; }
  .project-card:hover .p-flag { background: var(--accent); }
  .project-card .p-count { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 99px; background: var(--accent); color: #fff; font-size: 10.5px; font-weight: 650; display: inline-grid; place-items: center; }
  .project-card .p-more { position: absolute; top: 8px; right: 8px; width: 26px; height: 26px; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--card); color: var(--ink-3); font-size: 15px; line-height: 1; opacity: .85; transition: opacity .12s, border-color .12s, color .12s; }
  .project-card:hover .p-more, .project-card .p-more:focus-visible { opacity: 1; border-color: var(--accent); color: var(--accent); }
  .pj-danger-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid color-mix(in oklab, var(--danger) 34%, transparent); background: color-mix(in oklab, var(--danger) 7%, transparent); border-radius: var(--radius-sm); }
  .pj-del-table { width: 100%; border-collapse: collapse; font-size: 12px; }
  .pj-del-table th, .pj-del-table td { text-align: left; padding: 5px 0; border-bottom: 1px dashed var(--line); font-weight: 400; }
  .pj-del-table td:last-child { text-align: right; font-variant-numeric: tabular-nums; color: var(--ink-2); }
  .pj-empty { grid-column: 1 / -1; }
  @media (max-width: 1280px) { .pj-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 720px) { .pj-grid { grid-template-columns: 1fr; } .pj-search .input { width: 130px; } }
</style>`;

let query = '';

function metaOf(item) {
  if (item?.tender_meta && typeof item.tender_meta === 'object') return item.tender_meta;
  try { return JSON.parse(item?.tender_meta_json || '{}') || {}; } catch { return {}; }
}

function autoCode(existing) {
  const year = new Date().getFullYear();
  const used = new Set((existing || []).map((item) => String(item.code || '')));
  for (let i = 0; i < 60; i += 1) {
    const code = `XM-${year}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
    if (!used.has(code)) return code;
  }
  return `XM-${year}-${String(Date.now()).slice(-4)}`;
}

function toDeadline(value) {
  if (!value) return '';
  const text = String(value).replace('T', ' ');
  return text.length === 16 ? `${text}:00`.slice(0, 16) : text;
}

function deadlineInfo(deadline) {
  if (!deadline) return { text: '未设置', kind: 'plain' };
  const ms = new Date(deadline).getTime() - Date.now();
  if (Number.isNaN(ms)) return { text: String(deadline), kind: 'plain' };
  return { text: countdown(deadline), kind: ms < 0 ? 'bad' : ms < 7 * 86400000 ? 'warn' : 'ordinary' };
}

export default {
  title: '项目管理',
  async render(root, ctx, params) {
    let projects = [];
    let pendingByProject = new Map();

    root.innerHTML = `${STYLE}
      <div class="pj-head">
        <div>
          <div class="pj-eyebrow">标书生成 / 项目管理</div>
          <h1 class="pj-title">项目</h1>
          <p class="pj-desc">每个项目对应一份招标文件与一条技术方案流水线。项目卡上的待审数来自审核中心，可直接进入工作台处理。</p>
        </div>
        <div class="pj-actions">
          <label class="pj-search"><span>⌕</span><input class="input" id="pj-q" placeholder="按名称或编号搜索" value="${escapeHtml(query)}" /></label>
          <button class="btn primary" id="pj-new">＋ 新建项目</button>
        </div>
      </div>
      <div id="pj-grid" class="pj-grid">${loading('读取项目…')}</div>`;

    const grid = $('#pj-grid', root);
    const searchInput = $('#pj-q', root);

    function filtered() {
      const keyword = query.trim().toLowerCase();
      if (!keyword) return projects;
      return projects.filter((item) => `${item.name || ''} ${item.code || ''} ${item.industry || ''}`.toLowerCase().includes(keyword));
    }

    function card(item) {
      const deadline = deadlineInfo(item.deadline);
      const pending = pendingByProject.get(item.id) || 0;
      const latest = item.latest_run;
      const archived = item.status === 'archived';
      return `<article class="project-card" data-open="${item.id}">
        <span class="p-flag"></span>
        <div class="p-top">
          <div style="min-width:0;flex:1">
            <div class="p-name">${escapeHtml(item.name || '未命名项目')}</div>
            <div class="row mt4" style="gap:6px;flex-wrap:wrap">
              <span class="p-code">${escapeHtml(item.code || '-')}</span>
              ${archived ? pill('已归档', 'plain') : pill('进行中', 'ok')}
              ${pending ? `<span class="p-count" title="待审任务">${pending}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="p-facts">
          <span>采购人 <b>${escapeHtml(item.client || '—')}</b></span>
          <span>截止 <b>${escapeHtml(item.deadline ? fmtDate(item.deadline) : '未设置')}</b></span>
          <span>预算 <b>${escapeHtml(item.budget || '—')}</b></span>
          <span>行业 <b>${escapeHtml(item.industry || '—')}</b></span>
        </div>
        <div class="p-run">
          ${latest ? `${statusPill(latest.status)}<span>最近运行 ${escapeHtml(fmtRelative(latest.started_at))}</span>` : '<span>尚未启动工作流</span>'}
          <span class="right">${escapeHtml(deadline.text)}</span>
        </div>
        <div class="p-foot">
          <button class="btn sm primary" data-act="open" data-id="${item.id}">打开工作台</button>
          <button class="btn sm" data-act="run" data-id="${item.id}">▶ 启动工作流</button>
          <span class="right hint">${escapeHtml(item.run_count ? `${item.run_count} 次运行` : '')}</span>
        </div>
        <button class="icon-btn p-more" data-more="${item.id}" title="更多操作" aria-label="更多操作">⋯</button>
      </article>`;
    }

    function paint() {
      const list = filtered();
      if (!projects.length) {
        grid.innerHTML = `<div class="pj-empty card">${emptyState('还没有投标项目', '新建项目并粘贴招标文件全文，即可开始解析与写标', '▤')}
          <div class="row" style="justify-content:center"><button class="btn primary" id="pj-empty-new">＋ 新建项目</button></div></div>`;
        const button = $('#pj-empty-new', grid);
        if (button) button.onclick = openCreate;
        return;
      }
      if (!list.length) {
        grid.innerHTML = `<div class="pj-empty card">${emptyState('没有匹配的项目', `关键词「${query}」未命中名称/编号/行业`, '⌕')}</div>`;
        return;
      }
      grid.innerHTML = `${list.map(card).join('')}
        <button class="pj-new-tile" id="pj-new-tile"><span><b>＋</b>新建项目</span></button>`;
      bind();
    }

    function bind() {
      for (const node of $$('[data-act]', grid)) {
        node.onclick = async (event) => {
          event.stopPropagation();
          const id = Number(node.dataset.id);
          if (node.dataset.act === 'open') {
            location.hash = `#/projects/${id}?tab=overview`;
            return;
          }
          node.disabled = true;
          node.textContent = '启动中…';
          try {
            ctx.setProject(id);
            await ctx.startRun();
          } catch (error) {
            toast('启动失败', error?.message || String(error), 'bad');
            node.disabled = false;
            node.textContent = '▶ 启动工作流';
          }
        };
      }
      for (const node of $$('[data-open]', grid)) {
        node.onclick = () => { location.hash = `#/projects/${node.dataset.open}?tab=overview`; };
      }
      const tile = $('#pj-new-tile', grid);
      if (tile) tile.onclick = openCreate;
      for (const node of $$('[data-more]', grid)) {
        node.onclick = (event) => {
          event.stopPropagation();
          const target = projects.find((item) => Number(item.id) === Number(node.dataset.more));
          if (target) openProjectMenu(target);
        };
      }
    }

    /** 卡片右上角「⋯」：看关联数据量 + 删除项目 */
    function openProjectMenu(item) {
      const box = modal({
        title: '项目操作',
        body: `<div style="display:grid;gap:12px">
            <div>
              <div class="card-title" style="font-size:14px">${escapeHtml(item.name || '未命名项目')}</div>
              <div class="hint fs11 mt4">${escapeHtml(item.code || '-')}${item.industry ? ` · ${escapeHtml(item.industry)}` : ''}</div>
            </div>
            <div id="pjm-counts">${loading('统计关联数据…')}</div>
            <div class="pj-danger-row">
              <div style="flex:1;min-width:0">
                <div class="fs12" style="font-weight:600;color:var(--danger)">删除项目</div>
                <div class="hint fs11">运行记录、产物、审核任务、质量报告、导出文件会一并删除，不可撤销。</div>
              </div>
              <button class="btn sm danger" id="pjm-del">删除</button>
            </div>
          </div>`,
        footer: '<button class="btn" data-modal-close>关闭</button>',
      });

      api.deletionPreview(item.id).then((data) => {
        const counts = data?.counts || {};
        const rows = [
          ['工作流运行', counts.runs],
          ['节点执行', counts.nodes],
          ['产物版本', counts.artifacts],
          ['事件', counts.events],
          ['审核任务', counts.reviews],
          ['质量报告', counts.quality],
          ['导出文件', counts.exports],
          ['兼容任务', counts.tasks],
        ].filter(([, value]) => Number(value) > 0);
        const host = $('#pjm-counts', box.root);
        if (!host) return;
        host.innerHTML = rows.length
          ? `<table class="pj-del-table"><tbody>${rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${Number(value)}</td></tr>`).join('')}</tbody></table>`
          : '<div class="hint fs11">该项目还没有运行、审核或导出数据，删除只移除项目本身。</div>';
      }).catch((error) => {
        const host = $('#pjm-counts', box.root);
        if (host) host.innerHTML = `<div class="hint fs11">统计失败：${escapeHtml(error?.message || String(error))}</div>`;
      });

      $('#pjm-del', box.root).onclick = async () => {
        box.close();
        const ok = await confirmDialog(
          `确定删除「${item.name || '未命名项目'}」？关联的运行、审核、导出数据会一并清除，且无法撤销。`,
          { danger: true, okText: '确认删除' },
        );
        if (!ok) return;
        try {
          const result = await api.deleteProject(item.id);
          const removed = result?.removed || {};
          toast('项目已删除',
            `清理 运行 ${removed.runs || 0} / 审核 ${removed.reviews || 0} / 导出 ${removed.exports || 0} / 文件 ${removed.files || 0}`,
            'ok');
          const wasCurrent = Number(ctx.project?.id) === Number(item.id);
          projects = projects.filter((row) => Number(row.id) !== Number(item.id));
          ctx.projects = projects;
          if (wasCurrent) ctx.setProject(projects[0]?.id ?? 0);
          ctx.refreshShell?.().catch(() => {});
          paint();
        } catch (error) {
          toast('删除失败', error?.message || String(error), 'bad');
        }
      };
    }

    function openCreate() {
      const code = autoCode(projects);
      const { root: modalRoot, close } = modal({
        title: '新建投标项目',
        wide: true,
        body: `<div class="form-grid">
          <div class="field span2">
            <label>项目名称 <span class="accent">*</span></label>
            <input class="input" id="np-name" placeholder="如：XX市政务云平台运维服务项目" />
          </div>
          <div class="field">
            <label>项目编号</label>
            <div class="row" style="gap:6px">
              <input class="input" id="np-code" value="${escapeHtml(code)}" />
              <button class="btn sm" type="button" id="np-regen">重生成</button>
            </div>
          </div>
          <div class="field">
            <label>投标人</label>
            <input class="input" id="np-bidder" value="智标科技有限公司" />
          </div>
          <div class="field">
            <label>截止时间</label>
            <input class="input" id="np-deadline" type="datetime-local" />
          </div>
          <div class="field">
            <label>预算</label>
            <input class="input" id="np-budget" placeholder="如：480 万元" />
          </div>
          <div class="field">
            <label>行业</label>
            <input class="input" id="np-industry" placeholder="如：政务云 / 医疗信息化" />
          </div>
          <div class="field">
            <label>采购人</label>
            <input class="input" id="np-client" placeholder="如：XX市大数据管理局（可选）" />
          </div>
          <div class="field span2">
            <label>项目描述</label>
            <input class="input" id="np-desc" placeholder="一句话说明服务范围与关键承诺" />
          </div>
          <div class="field span2">
            <label>招标文件全文</label>
            <div class="row" style="gap:8px;align-items:center;margin-bottom:6px">
              <button class="btn sm" type="button" id="np-import">从文件导入（docx / doc / pdf）</button>
              <input type="file" id="np-file" accept=".docx,.doc,.wps,.pdf,.md,.txt" hidden />
              <span class="hint fs11" id="np-import-hint">也可以直接在下面粘贴正文</span>
            </div>
            <textarea class="textarea" id="np-tender" style="min-height:190px" placeholder="可直接粘贴招标文件全文：支持 Markdown 标题（# 一、项目概述）与编号条款（1. …），解析 Agent 据此抽取要求"></textarea>
            <div class="hint">提示：导入或粘贴后即可解析；留空也可以先建项目，稍后在项目工作台「招标解析」页签补充或上传。</div>
          </div>
        </div>`,
        footer: `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="np-submit">创建项目</button>`,
      });

      const regen = $('#np-regen', modalRoot);
      regen.onclick = () => { $('#np-code', modalRoot).value = autoCode(projects); };
      $('#np-name', modalRoot).focus();

      // 从文件导入招标正文：解析后回填文本框与项目元信息，避免先建项目再上传
      const importBtn = $('#np-import', modalRoot);
      const importFile = $('#np-file', modalRoot);
      if (importBtn && importFile) {
        importBtn.onclick = () => importFile.click();
        importFile.onchange = async () => {
          const file = importFile.files?.[0];
          importFile.value = '';
          if (!file) return;
          importBtn.disabled = true;
          importBtn.textContent = '解析中…';
          try {
            const result = await api.parseTenderFile(file);
            $('#np-tender', modalRoot).value = result.text || '';
            const hint = $('#np-import-hint', modalRoot);
            if (hint) hint.textContent = `${result.file} · ${result.chars} 字${result.pages ? ` · ${result.pages} 页` : ''}`;
            const meta = result.meta || {};
            const fill = (id, value) => { const node = $(id, modalRoot); if (node && !node.value.trim() && value) node.value = value; };
            fill('#np-name', meta.name);
            fill('#np-code', meta.code);
            fill('#np-budget', meta.budget);
            fill('#np-client', meta.owner);
            toast('已导入招标正文', `${result.file} · ${result.chars} 字`, 'ok');
          } catch (error) {
            toast('导入失败', error?.message || String(error), 'bad');
          } finally {
            importBtn.disabled = false;
            importBtn.textContent = '从文件导入（docx / doc / pdf）';
          }
        };
      }

      const submit = $('#np-submit', modalRoot);
      submit.onclick = async () => {
        const name = $('#np-name', modalRoot).value.trim();
        if (!name) { toast('请填写项目名称', '名称用于标识项目与生成文件名', 'warn'); return; }
        const body = {
          name,
          code: $('#np-code', modalRoot).value.trim() || autoCode(projects),
          bidderName: $('#np-bidder', modalRoot).value.trim(),
          description: $('#np-desc', modalRoot).value.trim(),
          tenderMeta: $('#np-client', modalRoot).value.trim() ? { purchaser: $('#np-client', modalRoot).value.trim() } : {},
          deadline: toDeadline($('#np-deadline', modalRoot).value),
          budget: $('#np-budget', modalRoot).value.trim(),
          industry: $('#np-industry', modalRoot).value.trim(),
          tenderText: $('#np-tender', modalRoot).value,
          tenderName: `${name}招标文件.md`,
        };
        submit.disabled = true;
        submit.textContent = '创建中…';
        try {
          const created = await api.createProject(body);
          projects = await api.projects();
          ctx.projects = projects;
          ctx.setProject(created.id);
          await ctx.refreshShell().catch(() => {});
          close();
          toast('项目已创建', created.code ? `编号 ${created.code}` : name, 'ok');
          if (body.deadline && !created.deadline) {
            toast('部分字段未落库', '截止/预算/行业字段当前服务端未写入（接口仅接收名称/编号/投标人/描述/招标文本）', 'warn');
          }
          paint();
        } catch (error) {
          submit.disabled = false;
          submit.textContent = '创建项目';
          toast('创建失败', error?.message || String(error), 'bad');
        }
      };
    }

    const newButton = $('#pj-new', root);
    if (newButton) newButton.onclick = openCreate;

    searchInput.addEventListener('input', debounce(() => {
      query = searchInput.value;
      paint();
    }, 160));

    try {
      const [list, pending] = await Promise.all([
        api.projects(),
        api.reviews({ status: 'pending' }).catch(() => []),
      ]);
      projects = list.map((item) => {
        return { ...item, client: metaOf(item)?.purchaser || metaOf(item)?.client || '' };
      });
      ctx.projects = projects;
      pendingByProject = new Map();
      for (const review of pending) {
        pendingByProject.set(review.project_id, (pendingByProject.get(review.project_id) || 0) + 1);
      }
      ctx.refreshShell().catch(() => {});
    } catch (error) {
      grid.innerHTML = `<div class="pj-empty card"><div class="card-title">项目加载失败</div>
        <p class="hint mt8">${escapeHtml(error?.message || String(error))}</p>
        <div class="row mt12"><button class="btn sm" id="pj-retry">重试</button></div></div>`;
      const retry = $('#pj-retry', grid);
      if (retry) retry.onclick = () => this.render(root, ctx, params);
      return null;
    }

    paint();
    if (String(params?.query?.new || '') === '1') openCreate();

    return {
      refresh: async () => {
        try {
          const [list, pending] = await Promise.all([
            api.projects(),
            api.reviews({ status: 'pending' }).catch(() => []),
          ]);
          projects = list.map((item) => {
            return { ...item, client: metaOf(item)?.purchaser || metaOf(item)?.client || '' };
          });
          ctx.projects = projects;
          pendingByProject = new Map();
          for (const review of pending) pendingByProject.set(review.project_id, (pendingByProject.get(review.project_id) || 0) + 1);
          paint();
        } catch { /* 静默：SSE 刷新失败不打断操作 */ }
      },
      destroy() { /* 无定时器 */ },
    };
  },
};




