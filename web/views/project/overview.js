// 概览：阶段进度 + 质量分 + 待办审核 + 最近运行 + 检查摘要 + 导出历史
import {
  $, escapeHtml, fmtBytes, fmtDate, fmtDateTime, fmtDuration, fmtRelative,
  pill, statusPill, verdictPill, scoreRing, barRow, dimLabel, emptyState, toast,
} from '../../lib/ui.js';
import { stepStates, STEP_META } from './data.js';

const STEP_TAB = { parse: 'tender', outline: 'plan', facts: 'plan', content: 'plan', checks: 'rejection', export: 'export' };

function runOf(ws) {
  const snap = ws?.latestRun || null;
  if (!snap) return { run: null, nodes: [], stats: null, progress: { done: 0, total: 0 } };
  return {
    run: snap.run || snap,
    nodes: snap.nodes || [],
    stats: snap.stats || null,
    progress: snap.progress || { done: 0, total: 0 },
  };
}

function durationText(run) {
  if (!run?.started_at) return '-';
  const start = new Date(run.started_at).getTime();
  const end = run.finished_at ? new Date(run.finished_at).getTime() : Date.now();
  const ms = Math.max(0, end - start);
  return run.finished_at ? fmtDuration(ms) : `${fmtDuration(ms)}（进行中）`;
}

function reviewSla(review) {
  const minutes = Number(review.minutes_left);
  if (review.overdue || minutes < 0) return pill('已超时', 'bad');
  if (!Number.isFinite(minutes)) return pill('待处理', 'warn');
  return pill(`剩 ${Math.max(0, Math.round(minutes))} 分钟`, minutes < 60 ? 'warn' : 'plain');
}

export default async function mount(container, host) {
  let disposed = false;

  function stepsMarkup() {
    const steps = stepStates(host.plan, host.exports.items.length);
    return `<div class="steps">
      ${steps.map((step) => `<div class="step clickable ${step.done ? 'done' : ''} ${step.active ? 'active' : ''}" data-step="${step.key}" title="${escapeHtml(STEP_META[step.key].desc)}">
        <span class="s-idx">${step.done ? '✓' : String(step.index).padStart(2, '0')}</span>
        <span class="s-label">${escapeHtml(step.label)}</span>
      </div>`).join('')}
    </div>`;
  }

  function qualityMarkup() {
    const quality = host.ws.quality;
    // 工作台 quality 只有 {total, verdict}：0 分且无维度时视为「尚无质量报告」
    const hasReport = Boolean(quality) && (Number(quality.score) > 0 || (quality.dimensions && Object.keys(quality.dimensions).length > 0));
    if (!hasReport) {
      return `<div class="card">
        <div class="card-title">质量评分</div>
        ${emptyState('暂无质量报告', '运行工作流后由质量 Agent 按五维 rubric 打分', '◔')}
        <div class="row" style="justify-content:center"><button class="btn sm" data-act="run">▶ 启动工作流</button></div>
      </div>`;
    }
    const dims = quality.dimensions ? Object.values(quality.dimensions) : [];
    return `<div class="card">
      <div class="card-title">质量评分 <span class="right">${quality.verdict ? verdictPill(quality.verdict) : ''}</span></div>
      <div class="row" style="gap:16px;align-items:flex-start;margin-top:10px">
        ${scoreRing(quality.score, 104)}
        <div class="grow">
          <div class="hint fs11">最近一次质量门禁</div>
          <div class="fs12 mt4">${escapeHtml(quality.nodeKey || '质量门禁')}${quality.iteration ? ` · 第 ${quality.iteration} 轮` : ''}</div>
          <div class="hint mt4">${quality.createdAt ? escapeHtml(fmtDateTime(quality.createdAt)) : '阈值 80 分（pass）· 60 分（revise）'}</div>
          <a class="btn xs mt8" href="#/quality">查看质量报告</a>
        </div>
      </div>
      ${dims.length ? `<div class="divider"></div><div class="stack" style="gap:7px">
        ${dims.map((dim) => barRow(dimLabel(dim.key), dim.score, 100, dim.score >= 80 ? 'jade' : dim.score >= 60 ? 'warn' : 'bad')).join('')}
      </div>` : ''}
    </div>`;
  }

  function pendingMarkup() {
    const list = host.ws.pendingReviews || [];
    return `<div class="card">
      <div class="card-title">待办审核 <span class="right"><a class="btn sm ghost" href="#/reviews">审核中心</a></span></div>
      ${list.length ? `<div class="list mt8">${list.slice(0, 5).map((review) => `
        <div class="list-row pointer" data-review="${escapeHtml(review.id)}">
          <div class="l-main">
            <div class="l-title">${escapeHtml(review.agent_label || review.gate_key || '审核门禁')}</div>
            <div class="l-sub"><span>第 ${review.level}/${review.level_total} 级</span><span>${escapeHtml(review.project_name || '')}</span></div>
          </div>
          ${reviewSla(review)}
        </div>`).join('')}</div>`
        : emptyState('没有待办审核', '工作流命中人工门禁时会出现在这里', '✓')}
    </div>`;
  }

  function runMarkup() {
    const { run, nodes, stats, progress } = runOf(host.ws);
    if (!run) {
      return `<div class="card">
        <div class="card-title">最近运行</div>
        ${emptyState('还没有运行记录', '启动工作流后会显示节点执行进度', '⌗')}
      </div>`;
    }
    const succeeded = stats?.succeeded ?? progress.done ?? 0;
    const waiting = stats?.waiting ?? nodes.filter((node) => node.status === 'waiting_human').length;
    const failed = stats?.failed ?? nodes.filter((node) => node.status === 'failed').length;
    const total = stats?.nodes ?? progress.total ?? 0;
    const pct = total ? Math.round((succeeded / total) * 100) : 0;
    const running = nodes.find((node) => node.status === 'running');
    return `<div class="card">
      <div class="card-title">最近运行 <span class="right">${statusPill(run.status)}</span></div>
      <div class="row mt8" style="gap:8px;align-items:baseline">
        <span class="mono fs11 muted">${escapeHtml(String(run.id || '').slice(0, 14))}</span>
        <span class="fs12 ellipsis">${escapeHtml(run.objective || '')}</span>
      </div>
      <div class="mt12">
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div class="row mt4 fs11 muted"><span>节点 ${succeeded}/${total || '-'} 完成</span>
          ${waiting ? `<span class="pill accent">待审 ${waiting}</span>` : ''}
          ${failed ? `<span class="pill bad">失败 ${failed}</span>` : ''}
          <span class="right">${escapeHtml(durationText(run))}</span></div>
      </div>
      <div class="row mt12 fs11 muted">
        <span>开始 ${escapeHtml(fmtRelative(run.started_at))}</span>
        ${run.plan_version ? `<span>计划版本 v${run.plan_version}</span>` : ''}
        ${running ? `<span class="pill info">执行中 ${escapeHtml(running.node_key || '')}</span>` : ''}
        <a class="btn sm ghost right" href="#/run/${escapeHtml(String(run.id || ''))}">打开运行 →</a>
      </div>
    </div>`;
  }

  function checksMarkup() {
    const rejection = host.checks.rejection;
    const duplicate = host.checks.duplicate;
    const stats = rejection?.stats || {};
    const items = rejection?.items || rejection?.vetoes || [];
    const vetoTotal = stats.veto_total ?? rejection?.veto_count ?? (Array.isArray(items) ? items.length : null);
    const unresponded = stats.unresponded ?? (Array.isArray(items) && items.length ? items.filter((item) => !item.responded).length : null);
    const similarity = duplicate?.max_similarity;
    return `<div class="card">
      <div class="card-title">检查摘要 <span class="right"><button class="btn sm ghost" data-goto="rejection">明细 →</button></span></div>
      <div class="wb-kpi-inline mt12">
        <div><div class="n ${unresponded ? 'danger-text' : ''}">${vetoTotal ?? '—'}</div><div class="l">废标条款</div></div>
        <div><div class="n ${unresponded ? 'danger-text' : ''}">${unresponded ?? '—'}</div><div class="l">未响应</div></div>
        <div><div class="n">${similarity === undefined || similarity === null ? '—' : `${Math.round(Number(similarity) * 100)}%`}</div><div class="l">查重最高相似度</div></div>
      </div>
      <div class="mt12">
        ${rejection || duplicate
    ? `<div class="row wrap fs11 muted" style="gap:8px">
          ${rejection ? pill(unresponded ? '废标风险' : '废标项已响应', unresponded ? 'bad' : 'ok') : ''}
          ${duplicate ? pill(`对比 ${duplicate.stats?.chapters ?? '—'} 节 · ${duplicate.pairs?.length ?? 0} 组重复`, 'plain') : ''}
          ${rejection?.checked_at ? `<span>检查于 ${escapeHtml(fmtDateTime(rejection.checked_at))}</span>` : ''}
        </div>
        ${rejection?.summary ? `<div class="hint mt8">${escapeHtml(String(rejection.summary))}</div>` : ''}`
    : emptyState('尚未执行检查', '废标检查与查重结果会汇总到这里', '⚑')}
      </div>
    </div>`;
  }

  function exportsMarkup() {
    const items = host.exports.items || [];
    return `<div class="card flush">
      <div class="card-head"><div class="card-title">导出历史</div>
        <span class="right fs11 muted">${host.exports.source === 'local' ? '本地记录（导出接口未实现时）' : ''}</span></div>
      ${items.length ? `<div class="table-wrap" style="max-height:240px">
        <table class="table compact">
          <thead><tr><th>文件名</th><th class="num">大小</th><th>时间</th><th>校验</th><th></th></tr></thead>
          <tbody>${items.slice(0, 8).map((item) => `<tr>
            <td class="ellipsis" style="max-width:220px">${escapeHtml(item.fileName || '-')}</td>
            <td class="num">${escapeHtml(fmtBytes(item.bytes))}</td>
            <td class="nowrap">${escapeHtml(fmtDateTime(item.createdAt))}</td>
            <td>${item.validation?.ok === false ? pill('未通过', 'bad') : pill('已生成', 'ok')}</td>
            <td class="col-tight">${item.downloadUrl ? `<a class="btn xs" href="${escapeHtml(item.downloadUrl)}" download>下载</a>` : ''}</td>
          </tr>`).join('')}</tbody>
        </table></div>`
    : emptyState('尚无导出记录', '正文与偏离表就绪后可在「导出」页签生成 Word', '▤')}
    </div>`;
  }

  function banner() {
    const nextStep = stepStates(host.plan, host.exports.items.length).find((step) => !step.done);
    if (!nextStep) {
      return `<div class="wb-banner"><i>◆</i><span>六个阶段全部完成。可在「导出」页签生成正式 Word，并在审核中心完成终审。</span></div>`;
    }
    const hint = {
      parse: '从「招标解析」开始：重新解析会抽出资格/技术/商务要求与废标条款。',
      outline: '解析完成后生成目录：章节会按评分办法与技术条款映射。',
      facts: '生成全局事实：项目元信息与关键指标供正文引用。',
      content: '生成正文：逐章写作并附带来源引用。',
      checks: '执行合规检查：核对废标条款响应与响应偏离。',
      export: '前置校验通过后即可导出 Word。',
    }[nextStep.key];
    return `<div class="wb-banner"><i>◆</i><span>下一步：<b>${escapeHtml(nextStep.label)}</b> · ${escapeHtml(hint)}</span>
      <button class="btn xs right" data-goto="${STEP_TAB[nextStep.key]}">前往</button></div>`;
  }

  function paint() {
    if (disposed) return;
    container.innerHTML = `
      ${banner()}
      <div class="mt12">${stepsMarkup()}</div>
      <div class="grid c2 mt12" style="align-items:start">
        ${qualityMarkup()}
        ${pendingMarkup()}
      </div>
      <div class="grid c2 mt12" style="align-items:start">
        ${runMarkup()}
        ${checksMarkup()}
      </div>
      <div class="mt12">${exportsMarkup()}</div>`;

    for (const node of container.querySelectorAll('[data-step]')) {
      node.onclick = () => host.switchTab(STEP_TAB[node.dataset.step] || 'overview');
    }
    for (const node of container.querySelectorAll('[data-goto]')) {
      node.onclick = (event) => { event.preventDefault(); host.switchTab(node.dataset.goto); };
    }
    for (const node of container.querySelectorAll('[data-review]')) {
      node.onclick = () => { location.hash = `#/review/${node.dataset.review}`; };
    }
    const runButton = container.querySelector('[data-act="run"]');
    if (runButton) {
      runButton.onclick = async () => {
        runButton.disabled = true;
        runButton.textContent = '启动中…';
        try { await host.ctx.startRun(); await host.reload(); }
        catch (error) { toast('启动失败', error?.message || String(error), 'bad'); runButton.disabled = false; runButton.textContent = '▶ 启动工作流'; }
      };
    }
  }

  paint();
  return { refresh: paint, destroy() { disposed = true; } };
}





