// 审核详情（HITL 主场）：产物正文 + 版本对比 + 质量证据 + 上游意见 + 历史 + 评论 + 四动作。
// 契约：render(root, ctx, params) → { refresh, destroy }。字段全部容错（packet 允许缺字段）。
import { api } from '../lib/api.js';
import {
  $, $$, escapeHtml, pill, statusPill, reviewStatusPill, verdictPill, drawer, modal, toast, emptyState, loading,
  markdown, diffView, scoreRing, barRow, copyText, dimLabel,
  fmtTime, fmtDateTime, fmtRelative, countdown, ACTION_LABEL, ROLE_LABEL,
} from '../lib/ui.js';

const esc = escapeHtml;
const ACTIONS = ['approve', 'reject', 'modify', 'reanalyze'];
const ACTION_CLASS = { approve: 'jade', reject: 'danger', modify: 'accent', reanalyze: 'primary' };
const ACTION_HINT = {
  approve: '通过后：若还有下一级审核 → 流转到下一级并保持挂起；否则门禁节点完成，工作流自动续跑。',
  reject: '驳回：必须选择上游目标 Agent，目标节点会被重新入队（iteration+1），下游产物失效。',
  modify: '修改：选择上游目标 + 结构化段落替换（每行「锚点=替换文本」），由上游 Agent 重新生成后再回到本门禁。',
  reanalyze: '要求重新分析：把任务连同意见退回上游 Agent 重新推理，适用于证据不足或方向错误。',
};
const AGENT_LABEL = {
  'parse-tender': '招标分析 Agent', 'bid-strategy': '投标策略 Agent', knowledge: '知识检索 Agent',
  tech: '技术方案 Agent', commercial: '商务标 Agent', compliance: '合规审查 Agent',
  quality: '质量评估 Agent', doc: '文档生成 Agent', supervisor: 'Supervisor',
};

const shortSha = (sha) => String(sha || '').slice(0, 10);

/** evidence 可能是字符串，也可能是数组（质量规则轨的命中证据列表，元素形如 {type,ref,excerpt}） */
const pickEvidence = (item) => {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return String(item ?? '');
  const ref = item.ref || item.rule || '';
  const text = item.excerpt || item.text || item.label || item.message || item.value || '';
  if (ref && text) return `${ref}：${text}`;
  return text || ref || JSON.stringify(item);
};
const evidenceText = (finding) => {
  const ev = finding?.evidence;
  if (Array.isArray(ev)) return ev.map(pickEvidence).filter(Boolean).join(' · ');
  if (ev === null || ev === undefined) return '';
  return pickEvidence(ev);
};

/* ------------------------------------------------------------ 产物渲染 */
function jsonTable(obj) {
  const rows = Object.entries(obj || {}).filter(([, v]) => v === null || typeof v !== 'object');
  const nested = Object.entries(obj || {}).filter(([, v]) => v !== null && typeof v === 'object');
  const body = rows.map(([k, v]) => `<tr><th style="width:180px;text-align:left">${esc(k)}</th><td style="text-align:left">${esc(String(v ?? '—'))}</td></tr>`).join('');
  return `<table class="table compact" style="margin:8px 0"><tbody>${body}</tbody></table>
    ${nested.map(([k, v]) => `<details class="mt8"><summary class="hint pointer">${esc(k)} · ${esc(Array.isArray(v) ? `${v.length} 项` : '对象')}</summary>
      <pre class="mono" style="white-space:pre-wrap;background:var(--card-2);padding:10px;border-radius:8px;margin-top:6px">${esc(JSON.stringify(v, null, 2).slice(0, 6000))}</pre></details>`).join('')}`;
}

function renderQualityPayload(payload) {
  const dims = payload.dimensions || {};
  const findings = Array.isArray(payload.findings) ? payload.findings : [];
  const judge = payload.judge || {};
  return `<div class="md">
    <h2>质量评估报告</h2>
    <p>节点 <code>${esc(payload.node_key || '-')}</code> · 第 ${esc(String(payload.iteration ?? 1))} 次评估
      · ${esc(payload.evaluated_at || '')}</p>
    <div class="row" style="gap:20px;align-items:center;flex-wrap:wrap">
      ${scoreRing(payload.total ?? 0, 104)}
      <div style="flex:1;min-width:220px">
        <div class="row" style="gap:6px">${verdictPill(payload.verdict)}<span class="pill plain">规则轨 · 确定性</span></div>
        <p class="hint fs12" style="margin-top:8px">${esc(typeof payload.summary === 'string' ? payload.summary : '由 14 条确定性规则与受限评委 rubric（不自我打分）共同产出，低于阈值会自动返工。')}</p>
      </div>
    </div>
    <h3>五维得分</h3>
    <table><thead><tr><th>维度</th><th class="nowrap">得分</th><th class="nowrap">权重</th><th>命中规则</th></tr></thead><tbody>
      ${Object.entries(dims).map(([key, dim]) => `<tr>
        <td>${esc(dimLabel(key))}</td><td><strong>${esc(String(dim.score))}</strong></td><td>${esc(String(dim.weight ?? '—'))}</td>
        <td>${(dim.rules || []).map((r) => `${esc(r.rule)}(${esc(String(r.score))})`).join('、') || '—'}</td>
      </tr>`).join('')}
    </tbody></table>
    <h3>规则证据（${findings.length} 条）</h3>
    <table><thead><tr><th class="nowrap" style="width:96px">规则</th><th class="nowrap" style="width:56px">得分</th><th class="nowrap" style="width:64px">级别</th><th>说明</th></tr></thead><tbody>
      ${findings.map((f) => `<tr>
        <td style="width:96px"><code class="nowrap">${esc(f.rule || '')}</code><div class="hint fs11">${esc(f.label || '')}</div></td>
        <td style="width:56px">${f.score === null || f.score === undefined ? '—' : esc(String(f.score))}</td>
        <td style="width:64px">${esc(f.severity || '')}</td>
        <td>${esc(f.message || '')}${evidenceText(f) ? `<div class="hint fs11" style="white-space:pre-wrap;margin-top:3px">${esc(evidenceText(f).slice(0, 240))}</div>` : ''}</td>
      </tr>`).join('')}
    </tbody></table>
    ${Object.keys(judge).length ? `<h3>评委轨迹</h3>
      <pre><code>${esc(JSON.stringify(judge, null, 2).slice(0, 4000))}</code></pre>` : ''}
  </div>`;
}

function renderArtifact(payload, summary) {
  if (payload === null || payload === undefined) {
    return emptyState('该版本没有正文', summary || '产物 payload 为空');
  }
  if (typeof payload === 'string') {
    const looksMarkdown = /(^|\n)#{1,4}\s|(^|\n)\s*[-*]\s|\|/.test(payload);
    return looksMarkdown ? `<div class="md">${markdown(payload)}</div>` : `<pre class="mono" style="white-space:pre-wrap">${esc(payload)}</pre>`;
  }
  if (typeof payload.markdown === 'string') return `<div class="md">${markdown(payload.markdown)}</div>`;
  if (typeof payload.content === 'string') return `<div class="md">${markdown(payload.content)}</div>`;
  if (payload.verdict !== undefined && payload.total !== undefined) return renderQualityPayload(payload);
  return `<div class="md"><p class="hint">结构化产物（JSON）</p>${jsonTable(payload)}
    <details class="mt12"><summary class="hint pointer">查看原始 JSON</summary>
      <pre class="mono" style="white-space:pre-wrap;background:var(--card-2);padding:10px;border-radius:8px;margin-top:6px">${esc(JSON.stringify(payload, null, 2).slice(0, 12000))}</pre></details></div>`;
}

/** 在正文里定位证据文本（TreeWalker + 临时 mark 高亮） */
function highlightInDoc(needle) {
  const doc = document.getElementById('artifact-doc');
  if (!doc) return false;
  doc.querySelectorAll('mark.f-hit').forEach((m) => { m.replaceWith(document.createTextNode(m.textContent || '')); });
  const target = String(needle || '').trim().slice(0, 40);
  if (!target) return false;
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.nodeValue && node.nodeValue.includes(target) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
  });
  const hit = walker.nextNode();
  if (!hit) return false;
  const idx = hit.nodeValue.indexOf(target);
  const mark = document.createElement('mark');
  mark.className = 'f-hit';
  mark.style.background = 'var(--amber-soft)';
  mark.style.outline = '2px solid var(--accent)';
  mark.style.borderRadius = '3px';
  mark.textContent = target;
  const tail = hit.splitText(idx);
  tail.splitText(target.length);
  tail.parentNode.insertBefore(mark, tail);
  mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return true;
}

export default {
  title: '审核详情',

  async render(root, ctx, params) {
    const reviewId = params?.id || String(location.hash).split('/')[2] || '';
    const state = {
      packet: null,
      runSnap: null,
      versions: [],
      version: null,
      history: [],
      comments: [],
      commentsAvailable: true,
      localComments: [],
      targets: [],
      error: '',
      destroyed: false,
      draft: '',
    };

    /* -------------------------------------------------- 数据加载 */
    async function loadCore() {
      const packet = await api.review(reviewId);
      state.packet = packet;
      const kind = String(packet.subject?.artifact_kind || packet.gate_key);
      const [baseKind, subKind] = kind.split(':');
      const runId = packet.run_id;
      state.version = packet.subject?.version ?? null;
      const [snap, history] = await Promise.all([
        api.run(runId).catch(() => null),
        api.reviewHistory(reviewId).catch(() => null),
      ]);
      state.runSnap = snap;
      // 仅当运行快照里确实存在该类产物时才拉版本列表（避免无意义的 404）；kind 可能带 :sub 后缀
      const hasKind = (snap?.artifacts || []).some((a) => String(a.kind).split(':')[0] === baseKind);
      let versions = [];
      if (hasKind) versions = await api.artifact(runId, baseKind, subKind).catch(() => []);
      state.versions = (versions || []).sort((a, b) => Number(a.version) - Number(b.version));
      state.history = Array.isArray(history) ? history
        : Array.isArray(history?.history) ? history.history
          : (Array.isArray(packet.history) ? packet.history : []);
      await loadComments();
      state.targets = resolveTargets();
    }

    async function loadComments() {
      try {
        const data = await api.reviewComments(reviewId);
        const list = Array.isArray(data) ? data : (Array.isArray(data?.comments) ? data.comments : []);
        state.comments = list;
        state.commentsAvailable = true;
      } catch {
        state.commentsAvailable = false;
        state.comments = [];
      }
    }

    function allComments() {
      return [...(state.comments || []), ...(state.localComments || [])];
    }

    /** 驳回/修改必须回退到上游：优先用 packet.targets，缺失时按 ancestors 生成 */
    function resolveTargets() {
      const packet = state.packet;
      const fromPacket = packet.targets || packet.allowed_targets;
      if (Array.isArray(fromPacket) && fromPacket.length) {
        return fromPacket.map((t) => (typeof t === 'string'
          ? { agent_key: t, label: AGENT_LABEL[t] || t }
          : { agent_key: t.agent_key || t.agent || t.key, label: t.label || AGENT_LABEL[t.agent_key] || t.agent_key }));
      }
      const nodes = state.runSnap?.nodes || [];
      if (!nodes.length) return [];
      const byKey = new Map(nodes.map((n) => [n.node_key, n]));
      const seen = new Set();
      const queue = [...(byKey.get(packet.gate_key)?.depends_on || [])].map((k) => (typeof k === 'string' ? k : k));
      while (queue.length) {
        const key = queue.shift();
        if (seen.has(key)) continue;
        seen.add(key);
        const node = byKey.get(key);
        for (const dep of node?.depends_on || []) queue.push(dep);
      }
      return [...new Set([...seen].map((k) => byKey.get(k)?.agent_key).filter(Boolean))]
        .map((agent) => ({ agent_key: agent, label: AGENT_LABEL[agent] || agent }));
    }

    function currentVersionRow() {
      if (!state.versions.length) return null;
      const wanted = Number(state.version);
      return state.versions.find((v) => Number(v.version) === wanted) || state.versions.at(-1);
    }

    /* -------------------------------------------------- 片段 */
    function levelTrack() {
      const total = Math.max(1, Number(state.packet.level_total) || 1);
      const cur = Math.min(total, Math.max(1, Number(state.packet.level) || 1));
      if (total === 1) {
        return `<span class="tag soft" title="该门禁只配置了一级审核">单级审核</span>`;
      }
      return `<div class="level-track" style="width:150px">
        ${Array.from({ length: total }, (_, i) => `<span class="lv ${i + 1 < cur ? 'done' : i + 1 === cur ? 'active' : ''}" title="第 ${i + 1} 级"></span>`).join('')}
      </div>`;
    }

    function header() {
      const p = state.packet;
      const sla = p.sla || {};
      const overdue = sla.overdue || Number(sla.minutes_left) < 0;
      return `<div class="page-head">
        <div>
          <div class="row wrap" style="gap:8px">
            <span class="page-title">${esc(p.project?.name || '审核详情')}</span>
            <span class="pill plain mono">${esc(p.gate_key)}</span>
            ${reviewStatusPill(p.status)}
            ${p.priority >= 2 ? `<span class="pill bad">优先级 ${esc(String(p.priority))}</span>` : ''}
          </div>
          <div class="page-desc">
            ${esc(p.gate_label || '人工门禁')} · 第 ${esc(String(p.level))}/${esc(String(p.level_total))} 级 · 产物
            <span class="mono">${esc(p.subject?.artifact_kind || '-')} v${esc(String(p.subject?.version ?? '?'))}</span>
            · 运行 ${statusPill(p.run_status || '-')}
          </div>
        </div>
        <div class="page-actions">
          <a class="btn" href="#/runs/${esc(p.run_id)}">查看运行</a>
          ${p.status === 'pending' ? '<button class="btn accent" id="btn-remind">催办</button>' : ''}
          ${ctx.user?.role === 'admin' && p.status === 'pending' ? '<button class="btn" id="btn-reassign">转派</button>' : ''}
          <a class="btn ghost" href="#/reviews">返回中心</a>
        </div>
      </div>
      <div class="card pad-sm mb16">
        <div class="row wrap" style="gap:16px">
          <div class="row" style="gap:8px">
            <span class="hint fs11">级别进度</span>${levelTrack()}
            <span class="fs12">第 ${esc(String(p.level))}/${esc(String(p.level_total))} 级</span>
          </div>
          <div class="row" style="gap:8px">
            <span class="hint fs11">SLA</span>
            <span class="pill ${overdue ? 'bad' : Number(sla.minutes_left) < 60 ? 'warn' : 'plain'}">${esc(countdown(sla.due_at))}</span>
            <span class="hint fs11">截止 ${fmtDateTime(sla.due_at)} · 提醒 ${fmtTime(sla.remind_at)}</span>
          </div>
          <div class="row" style="gap:8px;margin-left:auto">
            <span class="hint fs11">指派</span>
            <span class="tag">${esc(p.assignee_role ? (ROLE_LABEL[p.assignee_role] || p.assignee_role) : '项目负责人')}</span>
          </div>
        </div>
      </div>`;
    }

    function leftColumn() {
      const p = state.packet;
      const row = currentVersionRow();
      const payload = row?.payload_json ?? p.subject?.payload ?? null;
      const options = state.versions.length
        ? state.versions.map((v) => `<option value="${v.version}" ${Number(v.version) === Number(state.version) ? 'selected' : ''}>v${v.version} · ${esc(v.status || 'active')}</option>`).join('')
        : `<option value="${esc(String(p.subject?.version ?? 1))}">v${esc(String(p.subject?.version ?? 1))}</option>`;
      return `<div>
        <div class="card pad-sm mb12">
          <div class="flex-between">
            <div class="row" style="gap:8px">
              <span class="fw6">产物正文</span>
              <span class="pill info mono">${esc(p.subject?.artifact_kind || '-')}</span>
              <select class="select slim" id="ver-select" style="width:auto" ${state.versions.length ? '' : 'disabled'}>${options}</select>
              <button class="btn sm" id="btn-diff" ${state.versions.length > 1 ? '' : 'disabled'}>与上一版对比</button>
            </div>
            <div class="row" style="gap:8px">
              <span class="hint fs11 mono">sha ${esc(shortSha(row?.sha256))}</span>
              <span class="hint fs11">${esc(p.subject?.summary || row?.summary || '')}</span>
            </div>
          </div>
        </div>
        <div class="artifact-doc" id="artifact-doc">${renderArtifact(payload, p.subject?.summary)}</div>
      </div>`;
    }

    function qualityCard() {
      const q = state.packet.quality;
      if (!q) {
        return `<div class="card"><div class="card-title">质量卡</div>
          ${emptyState('尚无质量评估', '质量门禁未执行或该运行未启用评分')}</div>`;
      }
      const dims = q.dimensions || {};
      return `<div class="card">
        <div class="card-head" style="padding:0 0 10px;border:0">
          <div class="card-title">质量评分</div>
          <div class="right">${verdictPill(q.verdict)}</div>
        </div>
        <div class="row" style="gap:16px;align-items:center">
          ${scoreRing(q.total, 92)}
          <div class="grow">
            <div class="hint fs11">第 ${esc(String(q.iteration ?? 1))} 次评估 · ${Object.keys(dims).length} 个维度</div>
            <div class="hint fs11 mt4">阈值：≥80 达标 / 60-79 定向返工 / &lt;60 重新生成</div>
          </div>
        </div>
        <div class="stack mt12" style="gap:7px">
          ${Object.entries(dims).map(([key, dim]) => barRow(dimLabel(key), dim.score ?? 0, 100,
            (dim.score ?? 0) >= 80 ? 'jade' : (dim.score ?? 0) >= 60 ? 'warn' : 'bad')).join('')}
        </div>
        <div class="divider"></div>
        <div class="flex-between mb8"><span class="hint fs11">规则证据（点击定位正文）</span>
          <span class="hint fs11">${(q.findings || []).length} 条</span></div>
        <div class="scroll-y" style="max-height:320px">
          ${(q.findings || []).length ? q.findings.map((f, i) => {
            const skipped = f.skipped || f.score === null || f.score === undefined;
            const tone = skipped ? 'plain' : (f.severity === 'veto' || f.severity === 'blocking' || (f.score ?? 100) < 60) ? 'bad' : (f.score ?? 100) < 80 ? 'warn' : 'ok';
            return `
            <div class="finding ${tone === 'plain' ? '' : tone} ${skipped ? '' : 'pointer'}" data-finding="${i}">
              <span class="f-code">${esc(f.rule || f.code || 'RULE')}</span>
              <div class="f-body">
                <div class="f-title">${esc(f.message || f.title || '')}</div>
                ${evidenceText(f) ? `<div class="f-evidence">${esc(evidenceText(f).slice(0, 220))}</div>` : ''}
                <div class="row mt4" style="gap:6px">
                  ${f.dimension ? `<span class="tag soft">${esc(dimLabel(f.dimension))}</span>` : ''}
                  ${f.severity ? `<span class="tag soft">${esc(f.severity)}</span>` : ''}
                  ${skipped ? '<span class="tag soft">已跳过</span>' : f.score !== undefined ? `<span class="tag soft">${esc(String(f.score))} 分</span>` : ''}
                  ${evidenceText(f) ? `<button class="btn xs" data-copy="${esc(evidenceText(f).slice(0, 300))}">复制证据</button>` : ''}
                </div>
              </div>
            </div>`;
          }).join('') : '<div class="hint">无规则命中</div>'}
        </div>
      </div>`;
    }

    function upstreamCard() {
      const p = state.packet;
      const upstream = Array.isArray(p.upstream_reviews) && p.upstream_reviews.length
        ? p.upstream_reviews
        : (state.history || [])
          .filter((h) => h.gate_key !== p.gate_key || Number(h.level) < Number(p.level))
          .map((h) => ({
            gate_key: h.gate_key, level: h.level, action: h.action, comment: h.comment,
            reviewer: h.reviewer, at: h.at || h.created_at, targets: h.targets || h.targets_json,
          }));
      return `<div class="card">
        <div class="card-title">上游审核意见 <span class="hint" style="font-weight:400">跨门禁传递</span></div>
        ${upstream.length ? `<div class="timeline mt12">
          ${upstream.map((u) => `<div class="tl-item ${u.action === 'approve' ? 'ok' : 'accent'}">
            <div class="tl-head">
              <span class="pill plain mono">${esc(u.gate_key || '-')}</span>
              <span class="fs11">${esc(ACTION_LABEL[u.action] || u.action || '')}</span>
              <span class="tl-time">${fmtTime(u.at || u.created_at)}</span>
            </div>
            <div class="tl-body">
              <div>${esc(u.comment || '（无意见）')}</div>
              <div class="hint fs11 mt4">
                ${esc(u.reviewer?.display_name || u.reviewer_name || '审核人')} · 第 ${esc(String(u.level ?? 1))} 级
                ${(u.targets || []).length ? ` · 目标 ${esc([].concat(u.targets).join('、'))}` : ''}
              </div>
            </div>
          </div>`).join('')}
        </div>` : '<div class="hint mt8">暂无上游意见（本门禁是链路中第一个审核点）</div>'}
      </div>`;
    }

    function historyCard() {
      const rows = state.history || [];
      return `<div class="card">
        <div class="card-title">审核历史 <span class="right hint">${rows.length} 条</span></div>
        ${rows.length ? `<div class="timeline mt12">
          ${[...rows].reverse().map((h) => `<div class="tl-item ${h.action === 'approve' ? 'ok' : 'accent'}">
            <div class="tl-head"><span class="fs12">${esc(ACTION_LABEL[h.action] || h.action)}</span>
              <span class="hint fs11">${esc(h.gate_key || '')} · L${esc(String(h.level ?? 1))}</span>
              <span class="tl-time">${fmtTime(h.created_at || h.at)}</span></div>
            <div class="tl-body">${esc(h.comment || '（无意见）')}
              ${(h.edits_json || h.edits || []).length ? `<div class="hint fs11 mt4">结构化修改 ${(h.edits_json || h.edits).length} 处</div>` : ''}
            </div>
          </div>`).join('')}
        </div>` : '<div class="hint mt8">尚无决策记录</div>'}
      </div>`;
    }

    function commentsCard() {
      const rows = allComments();
      return `<div class="card">
        <div class="card-title">评论线程 <span class="right hint">${rows.length} 条</span></div>
        ${!state.commentsAvailable ? '<div class="hint fs11 mt4">评论接口未就绪（GET /api/reviews/:id/comments），新评论暂存在本地。</div>' : ''}
        <div class="mt8" id="comment-list">
          ${rows.length ? rows.map((c) => `<div class="comment">
            <div class="c-avatar">${esc((c.author?.display_name || c.display_name || c.author_name || 'U').slice(0, 1))}</div>
            <div class="c-body">
              <div class="c-head"><strong>${esc(c.author?.display_name || c.display_name || c.author_name || '成员')}</strong>
                <span>${fmtRelative(c.created_at)}</span>${c.local ? '<span class="pill warm">本地暂存</span>' : ''}</div>
              <div>${esc(c.body || '')}</div>
            </div>
          </div>`).join('') : '<div class="hint">还没有评论，先写下你的疑问或补充说明。</div>'}
        </div>
        <div class="mt12">
          <textarea class="textarea" id="comment-input" placeholder="补充说明、质疑或交接备注…（Ctrl/⌘ + Enter 发送）">${esc(state.draft)}</textarea>
          <div class="flex-between mt8">
            <span class="hint fs11">评论不改变裁决，只作为沟通记录</span>
            <button class="btn sm primary" id="comment-send" ${state.packet.status === 'pending' ? '' : 'disabled'}>发送评论</button>
          </div>
        </div>
      </div>`;
    }

    function actionBar() {
      const p = state.packet;
      const allowed = (p.allowed_actions || ACTIONS).filter((a) => ACTIONS.includes(a));
      const closed = p.status !== 'pending' && p.status !== 'in_review';
      const last = (state.history || []).at(-1);
      return `<div class="action-bar mt16">
        ${allowed.map((action) => `<button class="btn ${ACTION_CLASS[action]}" data-action="${action}" ${closed ? 'disabled' : ''}>
          ${ACTION_LABEL[action]}</button>`).join('')}
        <span class="action-note">
          ${closed
            ? `该任务已处理：${esc(ACTION_LABEL[last?.action] || p.status)} · ${esc(last?.comment || '')}`
            : '驳回 / 修改 / 要求重新分析必须选择上游目标并填写 ≥10 字意见；提交幂等（commandId）。'}
        </span>
      </div>`;
    }

    function paint() {
      if (state.destroyed) return;
      root.innerHTML = `${header()}
        <div class="review-split">
          ${leftColumn()}
          <div class="stack-gap">${qualityCard()}${upstreamCard()}${historyCard()}${commentsCard()}</div>
        </div>
        ${actionBar()}`;
      bind();
    }

    /* -------------------------------------------------- 交互 */
    function openDiff() {
      const p = state.packet;
      const kind = String(p.subject?.artifact_kind || p.gate_key);
      const to = Number(state.version ?? state.versions.at(-1)?.version ?? 1);
      const from = Number(state.versions.find((v) => Number(v.version) < to)?.version ?? to - 1);
      if (!(to > 0) || from < 1) { toast('版本不足', '至少需要两个版本才能对比', 'warn'); return; }
      const box = drawer(`版本对比 · ${kind} v${from} → v${to}`, loading('计算差异…'), { width: 720 });
      api.diff(p.run_id, kind, from, to)
        .then((diff) => {
          const add = (diff.ops || diff.lines || []).filter((o) => (o.type || o.kind) === 'add').length;
          const del = (diff.ops || diff.lines || []).filter((o) => (o.type || o.kind) === 'del').length;
          box.body.innerHTML = `<div class="row wrap mb12" style="gap:8px">
              <span class="pill info">v${esc(String(diff.from ?? from))} → v${esc(String(diff.to ?? to))}</span>
              <span class="pill ok">+${add}</span><span class="pill bad">-${del}</span>
              <span class="hint">${esc(diff.mode || '')}</span>
            </div>${diffView(diff)}`;
        })
        .catch((error) => {
          box.body.innerHTML = emptyState('无法对比', error.message || String(error));
        });
    }

    function openDecision(action) {
      const p = state.packet;
      const needTargets = action !== 'approve';
      const targets = state.targets || [];
      const targetHtml = needTargets
        ? (targets.length
          ? `<div class="field"><label>回退目标（仅列上游节点）</label>
              <div class="stack" style="gap:6px">
                ${targets.map((t) => `<label class="row" style="gap:8px">
                  <input type="checkbox" value="${esc(t.agent_key)}" data-target />
                  <span>${esc(t.label)} <span class="mono hint fs11">${esc(t.agent_key)}</span>
                    ${t.agent_key === 'quality' ? '<span class="tag soft">仅重跑评分</span>' : ''}</span></label>`).join('')}
              </div><div class="hint">服务端会校验目标必须是祖先节点（REVIEW_TARGET_NOT_ANCESTOR）。</div></div>`
          : `<div class="field"><label>回退目标</label><div class="hint">该门禁没有上游节点可选，无法回退。</div></div>`)
        : '';
      const editsHtml = action === 'modify'
        ? `<div class="field"><label>结构化修改（每行：段落锚点=替换文本）</label>
            <textarea class="textarea" id="dec-edits" style="min-height:110px" placeholder="例：5.2 运维响应时效=7×24 小时值守，故障 15 分钟响应"></textarea>
            <div class="hint">锚点会作为 find 字段提交，服务端按段落替换后由上游 Agent 重新生成。</div></div>`
        : '';
      const { root: modalRoot, close } = modal({
        title: `审核裁决 · ${ACTION_LABEL[action]}`,
        wide: true,
        body: `<p class="hint mb12">${esc(ACTION_HINT[action] || '')}</p>
          ${targetHtml}
          <div class="field"><label>审核意见 ${action === 'approve' ? '（可选）' : '（必填，≥10 字）'}</label>
            <textarea class="textarea" id="dec-comment" placeholder="说明依据、风险与期望的修改方向">${esc(state.draft)}</textarea>
            <div class="hint" id="dec-count">0 字</div></div>
          ${editsHtml}`,
        footer: `<button class="btn" data-modal-close>取消</button>
          <button class="btn ${ACTION_CLASS[action]}" id="dec-submit">提交${esc(ACTION_LABEL[action])}</button>`,
      });
      const commentEl = $('#dec-comment', modalRoot);
      const countEl = $('#dec-count', modalRoot);
      const sync = () => { countEl.textContent = `${commentEl.value.trim().length} 字`; };
      commentEl.oninput = sync;
      sync();
      commentEl.focus();
      $('#dec-submit', modalRoot).onclick = async (event) => {
        const button = event.currentTarget;
        const comment = commentEl.value.trim();
        const picked = $$('[data-target]', modalRoot).filter((i) => i.checked).map((i) => i.value);
        if (action !== 'approve' && comment.length < 10) { toast('意见太短', '请填写至少 10 个字的审核意见', 'warn'); commentEl.focus(); return; }
        if (needTargets && !picked.length) { toast('请选择回退目标', '驳回/修改/重新分析必须指定上游 Agent', 'warn'); return; }
        const edits = [];
        if (action === 'modify') {
          const raw = $('#dec-edits', modalRoot)?.value || '';
          for (const line of raw.split('\n')) {
            const text = line.trim();
            if (!text) continue;
            const idx = text.indexOf('=');
            if (idx <= 0) continue;
            edits.push({ find: text.slice(0, idx).trim(), replace: text.slice(idx + 1).trim() });
          }
          if (!edits.length) { toast('缺少结构化修改', '请按「锚点=替换文本」至少写一行', 'warn'); return; }
        }
        button.disabled = true;
        button.textContent = '提交中…';
        try {
          const result = await api.decide(reviewId, {
            action, comment, targets: picked, edits, commandId: crypto.randomUUID(),
          });
          close();
          toast('裁决已提交', `${ACTION_LABEL[action]}${result?.next_review ? ` · 进入第 ${result.next_review.level} 级` : ''}`, 'ok');
          if (result?.next_review?.id) {
            setTimeout(() => { location.hash = `#/reviews/${result.next_review.id}`; }, 500);
          } else {
            setTimeout(() => { location.hash = '#/reviews'; }, 600);
          }
        } catch (error) {
          button.disabled = false;
          button.textContent = `提交${ACTION_LABEL[action]}`;
          if (error.status === 409) {
            close();
            toast('该审核任务已被处理', `错误码 ${error.code || 'REVIEW_ALREADY_DECIDED'}，正在刷新…`, 'warn');
            refresh().catch(() => {});
          } else if (error.code === 'REVIEW_COMMENT_TOO_SHORT') {
            toast('意见太短', '请填写至少 10 个字', 'warn');
          } else if (error.code === 'REVIEW_TARGET_NOT_ANCESTOR') {
            toast('目标不是上游节点', '只能选择祖先节点作为回退目标', 'bad');
          } else {
            toast('提交失败', `${error.code || ''} ${error.message || ''}`.trim(), 'bad');
          }
        }
      };
    }

    function openReassign() {
      state.draft = $('#comment-input', root)?.value || state.draft;
      const box = modal({
        title: '转派审核任务',
        body: `<div class="field"><label>目标处理人</label>
          <div id="reassign-body">${loading('读取成员…')}</div></div>`,
        footer: `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="reassign-ok" disabled>转派</button>`,
      });
      let picker = null;
      const submit = $('#reassign-ok', box.root);
      api.users()
        .then((users) => {
          const list = (users || []).filter((u) => Number(u.id) !== Number(ctx.user?.id));
          if (!list.length) throw new Error('没有可转派的成员');
          $('#reassign-body', box.root).innerHTML = `<select class="select" id="reassign-select">
            ${list.map((u) => `<option value="${u.id}">${esc(u.display_name || u.username)} · ${esc(ROLE_LABEL[u.role] || u.role)}</option>`).join('')}
          </select>`;
          picker = () => Number($('#reassign-select', box.root).value);
          submit.disabled = false;
        })
        .catch(() => {
          $('#reassign-body', box.root).innerHTML = `<input class="input" id="reassign-id" placeholder="输入用户 ID" type="number" min="1" />
            <div class="hint">成员接口未就绪，请直接填写用户 ID。</div>`;
          picker = () => Number($('#reassign-id', box.root).value);
          submit.disabled = false;
        });
      submit.onclick = async () => {
        const assigneeId = picker?.();
        if (!assigneeId) { toast('请选择处理人', '', 'warn'); return; }
        submit.disabled = true;
        try {
          await api.reassign(reviewId, assigneeId);
          toast('已转派', `用户 #${assigneeId}`, 'ok');
          box.close();
          refresh().catch(() => {});
        } catch (error) {
          submit.disabled = false;
          toast('转派失败', `${error.code || ''} ${error.message || ''}`.trim(), 'bad');
        }
      };
    }

    function bind() {
      const select = $('#ver-select', root);
      if (select) {
        select.onchange = () => {
          state.version = Number(select.value);
          paint();
        };
      }
      const diffBtn = $('#btn-diff', root);
      if (diffBtn) diffBtn.onclick = openDiff;

      $$('[data-action]', root).forEach((button) => {
        button.onclick = () => openDecision(button.dataset.action);
      });

      $$('[data-finding]', root).forEach((node) => {
        node.onclick = () => {
          const findings = state.packet.quality?.findings || [];
          const finding = findings[Number(node.dataset.finding)] || {};
          const first = Array.isArray(finding.evidence) ? finding.evidence.find(Boolean) : finding.evidence;
          const needle = (typeof first === 'string' ? first : '') || finding.quote || finding.message || '';
          if (!highlightInDoc(needle)) toast('未在正文中定位到证据', '该证据可能来自结构化字段或已变更的版本', 'warn');
        };
      });

      $$('[data-copy]', root).forEach((button) => {
        button.onclick = (event) => { event.stopPropagation(); copyText(button.dataset.copy); };
      });

      const remind = $('#btn-remind', root);
      if (remind) {
        remind.onclick = async () => {
          remind.disabled = true;
          try {
            await api.remind(reviewId);
            toast('已催办', '已向责任人推送提醒，并重置提醒时间', 'ok');
          } catch (error) {
            toast('催办失败', error.message || String(error), 'bad');
          } finally {
            remind.disabled = false;
          }
        };
      }

      const reassign = $('#btn-reassign', root);
      if (reassign) reassign.onclick = openReassign;

      const input = $('#comment-input', root);
      if (input) {
        input.oninput = () => { state.draft = input.value; };
        input.onkeydown = (event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            $('#comment-send', root)?.click();
          }
        };
      }
      const send = $('#comment-send', root);
      if (send) {
        send.onclick = async () => {
          const body = ($('#comment-input', root)?.value || '').trim();
          if (!body) { toast('评论不能为空', '', 'warn'); return; }
          send.disabled = true;
          try {
            await api.addReviewComment(reviewId, body);
            state.draft = '';
            await loadComments();
            paint();
            toast('评论已发送', '', 'ok');
          } catch (error) {
            state.localComments.push({
              body, local: true, created_at: new Date().toISOString(),
              display_name: ctx.user?.display_name || '我',
            });
            state.draft = '';
            paint();
            toast('评论已本地暂存', `${error.code || error.status || ''} · 评论接口未就绪`, 'warn');
          } finally {
            send.disabled = false;
          }
        };
      }
    }

    async function refresh() {
      if (state.destroyed) return;
      // 输入中或弹窗打开时不重绘，避免吞掉草稿
      const active = document.activeElement;
      if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) return;
      if (document.getElementById('modal-root')?.children.length) return;
      try {
        await loadCore();
        paint();
      } catch (error) {
        toast('刷新失败', error.message || String(error), 'bad');
      }
    }

    /* -------------------------------------------------- 首屏 */
    root.innerHTML = loading('加载审核包…');
    try {
      await loadCore();
    } catch (error) {
      root.innerHTML = `<div class="page-head"><div><div class="page-title">审核详情</div></div></div>
        <div class="card"><div class="card-title">无法打开该审核任务</div>
        <p class="hint mt8">${esc(error.message || String(error))}</p>
        <div class="row mt12"><a class="btn sm" href="#/reviews">返回审核中心</a></div></div>`;
      return { refresh: () => {}, destroy: () => { state.destroyed = true; } };
    }
    paint();

    return {
      refresh,
      destroy: () => { state.destroyed = true; },
    };
  },
};


