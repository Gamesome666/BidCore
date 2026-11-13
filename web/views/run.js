// 运行详情：Supervisor 动态调度视图 —— DAG + 事件流 + 决策侧栏 + 节点抽屉。
// 数据源：api.run（快照）/ api.events（增量）/ api.artifacts / api.supervisor（缺失时降级到 plan + 事件）。
import { api } from '../lib/api.js';
import {
  $, $$, escapeHtml, pill, statusPill, verdictPill, dag, bindDag, dagLegend, drawer, confirmDialog,
  emptyState, loading, toast, fmtTime, fmtRelative, fmtDuration, markdown, dimLabel,
  scoreClass, scoreRing,
} from '../lib/ui.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE = new Set(['planning', 'running', 'replanning', 'waiting_human', 'paused']);
const MAX_EVENTS = 300;
const POLL_MS = 2500;

const esc = escapeHtml;

/* ------------------------------------------------------------------ 事件文案 */
function eventMeta(type) {
  const t = String(type || '');
  if (t.startsWith('plan.')) return { tag: '计划', cls: 'accent' };
  if (t.startsWith('supervisor.')) return { tag: '调度', cls: 'accent' };
  if (t === 'nodes.parallel') return { tag: '并行', cls: 'ok' };
  if (t === 'node.invalidated') return { tag: '失效', cls: 'bad' };
  if (t.startsWith('node.')) return t.includes('failed') ? { tag: '节点', cls: 'bad' } : { tag: '节点', cls: 'ok' };
  if (t.startsWith('quality.')) return t.includes('revise') ? { tag: '质量', cls: 'bad' } : { tag: '质量', cls: 'ok' };
  if (t.startsWith('review.')) return { tag: '审核', cls: 'accent' };
  if (t.startsWith('run.')) {
    if (t.includes('failed') || t.includes('cancel') || t.includes('paused')) return { tag: '运行', cls: 'bad' };
    if (t.includes('completed')) return { tag: '运行', cls: 'ok' };
    return { tag: '运行', cls: '' };
  }
  if (t.startsWith('budget.')) return { tag: '预算', cls: 'bad' };
  return { tag: t.split('.')[0] || '事件', cls: '' };
}

function listText(value, limit = 6) {
  if (Array.isArray(value)) return value.slice(0, limit).join(' + ');
  if (value === undefined || value === null) return '';
  return String(value);
}

function eventText(event) {
  const p = event.payload_json || {};
  const t = String(event.type || '');
  if (t === 'run.created') return `运行创建：${p.objective || ''}`;
  if (t === 'plan.created') return `计划 v${p.plan_version ?? '-'}（${p.node_count ?? '?'} 节点，来源 ${p.source || '-'}）${p.reason ? ` · 兜底原因 ${p.reason}` : ''}`;
  if (t === 'plan.fallback') return `兜底计划生效：${p.reason || ''}`;
  if (t === 'plan.revised') return `重规划 v${p.plan_version ?? '-'}：目标 ${listText(p.targets)}`;
  if (t === 'supervisor.plan_created') return `计划 v${p.plan_version ?? '-'} · ${p.node_count ?? '?'} 节点 · 并行组 ${(p.parallel_groups || []).length} 个 · ${p.rationale || ''}`;
  if (t === 'supervisor.rework' || t === 'quality.revise') return `质量返工（${p.total ?? '-'} 分）→ ${listText(p.targets)} ${p.reason || p.reasons ? `· ${p.reason || listText(p.reasons, 3)}` : ''}`;
  if (t === 'supervisor.replan') return `Supervisor 重排计划：${p.reason || '质量门禁触发'} → ${listText(p.targets || p.planned_targets)}`;
  if (t === 'supervisor.budget_warning') return `预算预警：已用 ${Math.round(Number(p.ratio || p.used_ratio || 0) * 100)}%，后续跳过第二评委`;
  if (t === 'nodes.parallel') return `并行调度 ${listText(p.nodes, 8)}${p.slots ? `（并发槽位 ${p.slots}）` : ''}`;
  if (t === 'node.started') return `${p.node_key} 开始执行（attempt ${p.attempt ?? '-'} · iteration ${p.iteration ?? '-'}）`;
  if (t === 'node.succeeded') return `${p.node_key} 完成${Array.isArray(p.artifacts) && p.artifacts.length ? ` → ${p.artifacts.map((a) => `${a.kind} v${a.version}`).join('、')}` : ''}`;
  if (t === 'node.failed') return `${p.node_key} 失败：${p.error || p.error_message || ''}`;
  if (t === 'node.invalidated') return `下游失效：${listText(p.nodes || p.node_keys, 8)}${p.reason ? ` · ${p.reason}` : ''}`;
  if (t === 'node.retry_manual') return `人工重试：${p.node_key}`;
  if (t === 'node.skipped') return `人工跳过：${p.node_key}（原状态 ${p.from_status || '-'}）`;
  if (t === 'quality.evaluated') return `质量评估 ${p.total ?? p.total_score ?? '-'} 分 · ${p.verdict || ''}${p.node_key ? `（${p.node_key}）` : ''}`;
  if (t === 'review.decided') return `审核决策：${p.action || ''} · 第 ${p.level ?? '-'} 级${p.comment ? ` · ${p.comment}` : ''}`;
  if (t === 'review.opened') return `人工门禁打开：${p.gate_key || ''}（第 ${p.level || 1}/${p.level_total || 1} 级）`;
  if (t === 'run.paused') return '运行已暂停（人工）';
  if (t === 'run.resumed') return `运行已恢复${p.pending_reviews ? `，仍有 ${p.pending_reviews} 个待审任务` : ''}`;
  if (t === 'run.cancelled') return '运行已取消';
  if (t === 'run.completed') return '工作流执行完成';
  if (t === 'run.recovered') return `崩溃恢复：${p.interrupted ?? 0} 个节点重新入队`;
  if (t === 'budget.exceeded') return '预算超限，运行挂起';
  const reason = p.rationale || p.reason || p.message || p.comment;
  if (reason) return String(reason);
  const raw = JSON.stringify(p);
  return raw && raw !== '{}' ? raw.slice(0, 240) : '—';
}

/** 决策列表：优先用 supervisor 接口，缺失时从事件流派生（同一口径） */
function decisionsFromEvents(events) {
  const keys = ['supervisor.', 'plan.', 'nodes.parallel'];
  return events
    .filter((e) => keys.some((k) => String(e.type).startsWith(k)) || e.type === 'node.invalidated')
    .slice(-40)
    .reverse()
    .map((e) => ({
      at: e.created_at,
      type: e.type,
      reason: eventText(e),
      target: listText(e.payload_json?.targets || e.payload_json?.node_keys || e.payload_json?.nodes || e.payload_json?.node_key, 6),
    }));
}

/** 计划的结构化并行组（按依赖深度分层，只保留同层 ≥2 的层） */
function parallelLayers(nodes) {
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const depth = new Map();
  const walk = (key, guard = new Set()) => {
    if (depth.has(key)) return depth.get(key);
    if (guard.has(key)) return 0;
    guard.add(key);
    const deps = (byKey.get(key)?.depends_on || []).filter((d) => byKey.has(d));
    const value = deps.length ? Math.max(...deps.map((d) => walk(d, guard))) + 1 : 0;
    depth.set(key, value);
    return value;
  };
  nodes.forEach((n) => walk(n.node_key));
  const groups = new Map();
  for (const node of nodes) {
    const d = depth.get(node.node_key) || 0;
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(node.node_key);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).filter(([, keys]) => keys.length > 1);
}

export default {
  title: '运行详情',

  async render(root, ctx, params) {
    const runId = params?.id || String(location.hash).split('/')[2] || '';
    const state = {
      snap: null,
      events: [],
      lastSeq: 0,
      sup: null,
      artifacts: [],
      qualityRows: [],
      docDownload: null,
      timer: null,
      busy: false,
      destroyed: false,
      error: '',
    };

    /* ------------------------------------------------ 数据 */
    async function loadSnapshot() {
      const snap = await api.run(runId);
      state.snap = snap;
      return snap;
    }

    async function loadEvents(reset = false) {
      if (reset) { state.events = []; state.lastSeq = 0; }
      const rows = await api.events(runId, state.lastSeq).catch(() => []);
      if (!rows?.length) return;
      const merged = new Map(state.events.map((e) => [e.seq, e]));
      for (const row of rows) merged.set(row.seq, row);
      state.events = [...merged.values()].sort((a, b) => a.seq - b.seq);
      state.lastSeq = state.events.at(-1)?.seq || state.lastSeq;
    }

    async function loadSupervisor() {
      try {
        state.sup = await api.supervisor(runId);
      } catch {
        state.sup = null; // 接口未就绪：降级到 plan + 事件流
      }
    }

    async function loadTechMeta() {
      try {
        const rows = await api.artifact(runId, 'tech.content');
        const payload = rows?.[0]?.payload_json;
        state.techMeta = payload
          ? { words: payload.total_words, rewritten: payload.llm_rewritten, error: payload.llm_error }
          : null;
      } catch {
        state.techMeta = null;
      }
    }

    async function loadLlmStatus() {
      try {
        state.llm = await api.llmStatus();
      } catch {
        state.llm = null;
      }
    }

    async function loadQualityRows() {
      try {
        state.qualityRows = await api.quality(runId);
      } catch {
        state.qualityRows = [];
      }
    }

    async function loadDocDownload() {
      try {
        const rows = await api.artifact(runId, 'doc.docx');
        const payload = rows?.[0]?.payload_json;
        state.docDownload = payload?.file
          ? { file: payload.file, size: payload.size, words: payload.words, sections: payload.sections?.length, gaps: payload.gaps?.length }
          : null;
      } catch {
        state.docDownload = null;
      }
    }

    async function loadArtifacts() {
      try {
        state.artifacts = await api.artifacts(runId);
      } catch {
        state.artifacts = state.snap?.artifacts || [];
      }
    }

    /* ------------------------------------------------ 派生 */
    const run = () => state.snap?.run || {};
    const nodes = () => state.snap?.nodes || [];
    const plan = () => state.snap?.plan || null;
    const pendingReviews = () => (state.snap?.reviews || []).filter((r) => r.status === 'pending' || r.status === 'in_review');
    const lastQuality = () => (state.snap?.quality || []).at(-1) || null;
    const doneCount = () => nodes().filter((n) => n.status === 'succeeded' || n.status === 'skipped').length;

    function budget() {
      const supUsed = state.sup?.used || {};
      const ctxBudget = run().context_json?.budget || {};
      const cap = state.sup?.budget || run().budget_json || {};
      const usedTokens = Number(supUsed.tokens ?? ctxBudget.tokens_used ?? 0);
      const usedCalls = Number(supUsed.agent_calls ?? ctxBudget.agent_calls ?? 0);
      const maxTokens = Number(cap.max_tokens || 0) || 3000000;
      const maxCalls = Number(cap.max_agent_calls || 0) || 40;
      const wall = Number(supUsed.wall_ms ?? ctxBudget.wall_ms ?? 0);
      const ratio = Number(state.sup?.budget_ratio ?? (maxTokens ? usedTokens / maxTokens : 0));
      return { usedTokens, usedCalls, maxTokens, maxCalls, wall, ratio, warning: Boolean(state.sup?.budget_warning) };
    }

    /** 预算条：极小占比也要可见（最小 2%） */
    const barWidth = (used, max) => {
      if (!used) return 0;
      return Math.max(2, Math.min(100, (used / (max || 1)) * 100));
    };

    function decisions() {
      const fromApi = state.sup?.decisions || state.sup?.decision_list;
      if (Array.isArray(fromApi) && fromApi.length) {
        return fromApi.slice(-12).reverse().map((d) => ({
          at: d.at || d.created_at,
          type: d.type || d.kind || 'supervisor',
          reason: d.reason || d.rationale || d.summary || '',
          target: listText(d.targets || d.target),
        }));
      }
      return decisionsFromEvents(state.events).slice(0, 12);
    }

    /* ------------------------------------------------ 片段 */
    function header() {
      const r = run();
      const can = {
        pause: ['running', 'planning', 'replanning'].includes(r.status),
        resume: r.status === 'paused',
        cancel: !TERMINAL.has(r.status),
        reconcile: !TERMINAL.has(r.status) || r.status === 'failed',
      };
      const pending = pendingReviews();
      return `<div class="page-head">
        <div>
          <div class="row wrap" style="gap:8px">
            <span class="page-title">运行详情</span>
            ${statusPill(r.status)}
            <span class="pill info">计划 v${esc(String(r.plan_version || 0))}</span>
            ${plan()?.source ? `<span class="pill ${plan().source === 'llm' ? 'violet' : 'plain'}">${plan().source === 'llm' ? 'LLM 规划' : '确定性兜底'}</span>` : ''}
            ${r.dry_run ? '<span class="pill violet">dry-run</span>' : ''}
          </div>
          <div class="page-desc">
            <span class="mono">${esc(runId)}</span> · ${esc(r.objective || '')}
            · 启动 ${fmtTime(r.started_at)} · 更新 ${fmtRelative(r.updated_at)}
          </div>
        </div>
        <div class="page-actions">
          ${pending.length ? `<button class="btn accent" data-go="review">✓ 回到审核（${pending.length}）</button>` : ''}
          <a class="btn" href="#/quality?runId=${encodeURIComponent(runId)}">质量报告</a>
          ${can.pause ? '<button class="btn" data-cmd="pause">暂停</button>' : ''}
          ${can.resume ? '<button class="btn jade" data-cmd="resume">继续</button>' : ''}
          <button class="btn" data-cmd="reconcile" title="回收失联租约并重新入队中断节点">对账恢复</button>
          ${can.cancel ? '<button class="btn danger" data-cmd="cancel">取消</button>' : ''}
        </div>
      </div>`;
    }

    function kpis() {
      const r = run();
      const total = nodes().length;
      const done = doneCount();
      const q = lastQuality();
      const b = budget();
      return `<div class="grid c4 mb16">
        <div class="kpi"><div class="k-label">计划版本</div>
          <div class="k-value">v${esc(String(r.plan_version || 0))}</div>
          <div class="k-foot">${esc(plan()?.source === 'llm' ? '模型规划' : '确定性兜底计划')} · 并行度 ${esc(String(r.parallelism ?? 2))}</div></div>
        <div class="kpi ${done === total && total ? 'jade' : ''}"><div class="k-label">节点完成</div>
          <div class="k-value">${done}<small>/ ${total || '?'}</small></div>
          <div class="bar thin mt8"><i style="width:${total ? Math.round((done / total) * 100) : 0}%"></i></div>
          <div class="k-foot">等待人工 ${(state.snap?.stats?.waiting ?? nodes().filter((n) => n.status === 'waiting_human').length)} · 失败 ${(state.snap?.stats?.failed ?? 0)}</div></div>
        <div class="kpi ${q ? (q.total_score >= 80 ? 'jade' : 'warn') : ''}"><div class="k-label">质量分</div>
          <div class="k-value ${q ? scoreClass(q.total_score) : ''}">${q ? q.total_score : '—'}<small>分</small></div>
          <div class="k-foot">${q ? `${verdictPill(q.verdict)} · 第 ${q.iteration} 次评估` : '尚未评估（质量节点未执行）'}</div></div>
        <div class="kpi"><div class="k-label">预算使用</div>
          <div class="k-value">${(b.usedTokens / 1000).toFixed(0)}<small>K tokens</small></div>
          <div class="bar thin mt8"><i style="width:${Math.min(100, (b.usedTokens / b.maxTokens) * 100).toFixed(1)}%"></i></div>
          <div class="k-foot">Agent 调用 ${b.usedCalls}/${b.maxCalls} · 墙钟 ${fmtDuration(b.wall)}</div></div>
      </div>`;
    }

    /** 模型未启用 / 调用失败提示：让“为什么正文像模板”一眼可见 */
    function llmBanner() {
      const llm = state.llm;
      const tech = state.techMeta;
      if (!llm) return '';
      if (llm.mode === 'mock') {
        return `<div class="card mb16" style="border-color:var(--amber,#b7791f)">
          <div class="flex-between">
            <div>
              <div class="fw6" style="font-size:14px">本次正文由模板生成（模型未启用）</div>
              <div class="hint fs12" style="margin-top:4px">平台设置里当前是 mock 模式，技术方案每章只有 200–350 字。填好 Base URL 与 API Key 并保存后重跑，才会由模型逐章生成。</div>
            </div>
            <a class="btn accent" href="#/settings">去配置模型</a>
          </div>
        </div>`;
      }
      if (tech?.error) {
        return `<div class="card mb16" style="border-color:var(--danger,#c53030)">
          <div class="flex-between">
            <div>
              <div class="fw6" style="font-size:14px">模型调用失败，正文已回退模板</div>
              <div class="hint fs12" style="margin-top:4px">错误：${esc(String(tech.error).slice(0, 160))}</div>
              <div class="hint fs12">常见原因：模型名不被服务端接受、Base URL 少 /v1、Key 无效或额度不足。</div>
            </div>
            <a class="btn accent" href="#/settings">去检查配置</a>
          </div>
        </div>`;
      }
      return '';
    }

    /** 跑完后最该看到的东西：标书文件下载 */
    function downloadCard() {
      const doc = state.docDownload;
      if (!doc?.file) return '';
      const size = doc.size ? `${(doc.size / 1024).toFixed(1)} KB` : '';
      return `<div class="card mb16" style="border-color:var(--accent)">
        <div class="flex-between">
          <div>
            <div class="fw6" style="font-size:14.5px">投标文件已生成，可下载</div>
            <div class="hint fs12" style="margin-top:4px">${esc(doc.sections ? `${doc.sections} 项 · ` : '')}${esc(size)}${doc.words ? ` · ${doc.words} 字` : ''}${doc.gaps ? ` · 待编制 ${doc.gaps} 项` : ''}</div>
          </div>
          <a class="btn accent" href="${esc(doc.file)}" download>下载 Word（.docx）</a>
        </div>
      </div>`;
    }

    /** 质量迭代轨迹：让人看见“返工了几轮、每轮多少分、差在哪” */
    function qualityTimeline() {
      const rows = state.qualityRows || [];
      if (!rows.length) return '';
      const cell = (row, index) => {
        const prev = index ? Number(rows[index - 1].total_score) : null;
        const delta = prev === null ? '—' : `${Number(row.total_score) - prev >= 0 ? '+' : ''}${Number(row.total_score) - prev}`;
        const findings = (row.findings_json || []).filter((f) => Number(f.score) < 100).slice(0, 3)
          .map((f) => `${f.rule} ${f.score}：${String(f.message || '').slice(0, 26)}`).join('；');
        const cls = row.verdict === 'pass' ? 'ok' : row.verdict === 'revise' ? 'warn' : 'bad';
        return `<tr>
          <td>第 ${Number(row.iteration || index + 1)} 轮</td>
          <td><b>${esc(String(row.total_score))}</b></td>
          <td class="hint">${esc(delta)}</td>
          <td><span class="pill ${cls}">${esc(row.verdict === 'pass' ? '达标' : row.verdict === 'revise' ? '定向返工' : '重新生成')}</span></td>
          <td class="hint">${esc(findings || '—')}</td>
        </tr>`;
      };
      return `<div class="card mb16">
        <div class="flex-between">
          <div class="fw6">质量迭代轨迹 <span class="hint fs11">共评估 ${rows.length} 轮，最多 3 轮后转人工</span></div>
          <a class="btn sm" href="#/quality?runId=${encodeURIComponent(runId)}">查看完整质量报告</a>
        </div>
        <table class="table" style="font-size:12px;margin-top:8px">
          <thead><tr><th style="width:72px">轮次</th><th style="width:64px">分数</th><th style="width:56px">Δ</th><th style="width:88px">判定</th><th>主要扣分项</th></tr></thead>
          <tbody>${rows.map(cell).join('')}</tbody>
        </table>
        <div class="hint fs11" style="margin-top:8px">每轮只重跑被判定的 Agent（如 knowledge / tech / commercial），不是整条流水线重来；返工上限取「平台设置 → 最大迭代」。</div>
      </div>`;
    }

    /** 人工闸门横幅：让“该我签了”一眼可见，不用去审核中心翻 */
    function gateBanner() {
      const pending = pendingReviews();
      if (!pending.length || run().status !== 'waiting_human') return '';
      return `<div class="card mb16" style="border-color:var(--accent)">
        <div class="flex-between">
          <div>
            <div class="fw6" style="font-size:14.5px">流程停在人工审核：${pending.length} 项等你确认</div>
            <div class="hint fs12" style="margin-top:4px">通过后流程会自动继续；也可以稍后在「审核中心」处理。</div>
          </div>
          <button class="btn accent" data-go="review">现在去审核 →</button>
        </div>
      </div>`;
    }

    function dagCard() {
      const list = nodes();
      return `<div class="card">
        <div class="card-head" style="padding:0 0 10px;border:0">
          <div class="card-title">执行图 <span class="hint" style="font-weight:400">自上而下 · 同层即并行</span></div>
          <div class="right hint">点击节点查看抽屉</div>
        </div>
        ${list.length ? dag(list) + dagLegend() : emptyState('还没有节点', 'Supervisor 生成计划后这里会出现执行图')}
      </div>`;
    }

    function eventsCard() {
      const list = [...state.events].sort((a, b) => b.seq - a.seq).slice(0, MAX_EVENTS);
      return `<div class="card" id="ev-card">
        <div class="card-head" style="padding:0 0 10px;border:0">
          <div class="card-title">事件流</div>
          <div class="right hint">${list.length} / ${state.events.length} 条 · 最新在上</div>
        </div>
        ${list.length ? `<div class="scroll-y" id="ev-stream" style="max-height:460px">
          <div class="timeline">
            ${list.map((event) => {
              const meta = eventMeta(event.type);
              return `<div class="tl-item ${meta.cls}">
                <div class="tl-head"><span class="pill ${meta.cls === 'bad' ? 'bad' : meta.cls === 'ok' ? 'ok' : meta.cls === 'accent' ? 'accent' : 'plain'}">${esc(meta.tag)}</span>
                  <span class="mono fs11 muted">${esc(event.type)}</span>
                  <span class="tl-time">${fmtTime(event.created_at, false)}</span></div>
                <div class="tl-body">${esc(eventText(event))}</div>
              </div>`;
            }).join('')}
          </div>
        </div>` : emptyState('暂无事件', '运行开始后会记录计划、调度、节点与审核流水')}
      </div>`;
    }

    function supervisorCard() {
      // 注意：接口可能返回空数组（truthy），必须取"第一个非空数组"
      const pickList = (...values) => values.find((v) => Array.isArray(v) && v.length) || [];
      const batches = pickList(state.sup?.parallel_batches, state.sup?.parallel_groups, state.sup?.plan?.planned_parallel_groups);
      const computed = parallelLayers(nodes());
      const groups = batches.length
        ? batches.map((g, i) => ({ index: i + 1, keys: Array.isArray(g) ? g : (g.nodes || g.keys || []) }))
        : computed.map(([depth, keys], i) => ({ index: i + 1, note: `L${depth}`, keys }));
      const list = decisions();
      const rationale = state.sup?.rationale || plan()?.rationale || '';
      const stops = state.sup?.plan?.stop_conditions || state.sup?.stop_conditions || [];
      const stopLabel = {
        veto_unresolved: '废标未消除即停', budget_exceeded: '预算超限即停',
        quality_iteration_limit: '质量迭代上限即停',
      };
      return `<div class="card">
        <div class="card-head" style="padding:0 0 10px;border:0">
          <div class="card-title">Supervisor 调度</div>
          <div class="right"><span class="pill ${state.sup ? 'ok' : 'plain'}">${state.sup ? '实时接口' : '计划/事件派生'}</span></div>
        </div>
        <p class="fs12" style="color:var(--ink-3)">${esc(rationale) || '<span class="hint">计划未给出 rationale</span>'}</p>
        <div class="row wrap mt8" style="gap:6px">
          <span class="pill plain">计划 v${esc(String(state.sup?.plan_version ?? run().plan_version ?? 0))}</span>
          <span class="pill plain">${esc(String(plan()?.node_count || nodes().length))} 节点</span>
          ${state.sup?.plan?.source ? `<span class="pill ${state.sup.plan.source === 'llm' ? 'violet' : 'plain'}">${state.sup.plan.source === 'llm' ? 'LLM 规划' : '兜底计划'}</span>` : ''}
        </div>
        ${groups.length ? `<div class="mt12">
          <div class="hint fs11 mb4">并行批次（planned_parallel_groups · 同层可并发）</div>
          <div class="row wrap" style="gap:6px">
            ${groups.map((g) => `<span class="tag soft" title="第 ${g.index} 批">批次 ${g.index}${g.note ? ` · ${esc(g.note)}` : ''}：${esc(g.keys.join(' + '))}</span>`).join('')}
          </div>
        </div>` : '<div class="hint mt8">计划中无并行层（全串行）</div>'}
        ${stops.length ? `<div class="mt8"><div class="hint fs11 mb4">停止条件</div>
          <div class="row wrap" style="gap:6px">${stops.map((s) => `<span class="tag">${esc(stopLabel[s] || s)}</span>`).join('')}</div></div>` : ''}
        <div class="divider"></div>
        <div class="hint fs11 mb8">决策流水（${list.length}）</div>
        ${list.length ? `<div class="timeline">
          ${list.map((d) => `<div class="tl-item ${String(d.type).includes('rework') || String(d.type).includes('invalid') ? 'bad' : 'accent'}">
            <div class="tl-head"><span class="fs11 mono muted">${esc(String(d.type).replace('supervisor.', ''))}</span>
              <span class="tl-time">${fmtTime(d.at, false)}</span></div>
            <div class="tl-body">${esc(String(d.reason || '').slice(0, 180))}${d.target ? `<div class="hint fs11 mt4">目标 · ${esc(d.target)}</div>` : ''}</div>
          </div>`).join('')}
        </div>` : '<div class="hint">暂无决策事件</div>'}
      </div>`;
    }

    function budgetCard() {
      const b = budget();
      const tokenPct = barWidth(b.usedTokens, b.maxTokens);
      const callPct = barWidth(b.usedCalls, b.maxCalls);
      const wallPct = barWidth(b.wall, 14400000);
      return `<div class="card">
        <div class="card-head" style="padding:0 0 10px;border:0">
          <div class="card-title">预算</div>
          <div class="right"><span class="pill ${b.warning ? 'bad' : b.ratio > 0.6 ? 'warn' : 'ok'}">${(b.ratio * 100).toFixed(2)}%</span></div>
        </div>
        <div class="stack mt8" style="gap:10px">
          <div><div class="flex-between fs11 muted"><span>Tokens</span><span class="mono">${b.usedTokens.toLocaleString()} / ${b.maxTokens.toLocaleString()}</span></div>
            <div class="bar thin mt4 ${tokenPct > 85 ? 'bad' : tokenPct > 60 ? 'warn' : 'jade'}"><i style="width:${tokenPct}%"></i></div></div>
          <div><div class="flex-between fs11 muted"><span>Agent 调用</span><span class="mono">${b.usedCalls} / ${b.maxCalls}</span></div>
            <div class="bar thin mt4 ${callPct > 85 ? 'bad' : ''}"><i style="width:${callPct}%"></i></div></div>
          <div><div class="flex-between fs11 muted"><span>墙钟</span><span class="mono">${fmtDuration(b.wall)}</span></div>
            <div class="bar thin mt4"><i style="width:${wallPct}%"></i></div></div>
        </div>
        <div class="hint fs11 mt8">${b.warning ? '已触发预算预警：后续跳过第二评委，先保结果。' : '超过 85% 会触发预算预警：跳过第二评委先保结果。'}</div>
      </div>`;
    }

    function artifactsCard() {
      const list = state.artifacts?.length ? state.artifacts : (state.snap?.artifacts || []);
      return `<div class="card">
        <div class="card-head" style="padding:0 0 10px;border:0">
          <div class="card-title">产物</div>
          <div class="right hint">${list.length} 个版本</div>
        </div>
        ${list.length ? `<div class="stack" style="gap:2px">
          ${list.slice(0, 24).map((a) => `
            <div class="list-row" data-artifact="${esc(a.kind)}" data-version="${esc(String(a.version))}" style="padding:7px 4px;cursor:pointer">
              <div class="l-main">
                <div class="l-title" style="font-size:12.2px">${esc(a.kind)} <span class="pill plain" style="height:17px;font-size:10px">v${esc(String(a.version))}</span>
                  ${a.status && a.status !== 'active' ? `<span class="pill violet" style="height:17px;font-size:10px">${esc(a.status)}</span>` : ''}</div>
                <div class="l-sub ellipsis" style="max-width:300px">${esc(a.summary || '（无摘要）')}</div>
              </div>
              <span class="mono fs11 muted">${esc(String(a.sha256 || '').slice(0, 7))}</span>
            </div>`).join('')}
        </div>` : emptyState('暂无产物', '节点成功后会生成带版本号与 sha256 的产物')}
      </div>`;
    }

    function paint() {
      if (state.destroyed) return;
      const r = run();
      root.innerHTML = `
        ${header()}
        ${llmBanner()}
        ${downloadCard()}
        ${gateBanner()}
        ${qualityTimeline()}
        ${kpis()}
        <div class="grid side-lg">
          <div class="stack-gap">
            ${dagCard()}
            ${eventsCard()}
          </div>
          <div class="stack-gap">
            ${supervisorCard()}
            ${budgetCard()}
            ${artifactsCard()}
            ${r.error_message ? `<div class="card"><div class="card-title danger-text">错误</div>
              <div class="mono fs11 mt8">${esc(r.error_code || '')}</div>
              <p class="fs12 mt4">${esc(r.error_message)}</p></div>` : ''}
          </div>
        </div>`;
      bind();
    }

    /* ------------------------------------------------ 抽屉 */
    async function openNode(nodeKey) {
      const node = nodes().find((n) => n.node_key === nodeKey);
      if (!node) { toast('节点不存在', nodeKey, 'bad'); return; }
      const report = (state.snap?.quality || []).filter((q) => q.node_key === nodeKey).at(-1);
      const output = node.output_json ? String(node.output_json) : '';
      const filtered = output && output !== '{}' && !output.includes('review_feedback') ? output : '';

      // 产物预览（节点产出的正文/结构化摘要，截断展示）
      let artifactHtml = '<span class="hint">该节点未产出文件</span>';
      if (node.artifact_kind) {
        const [base, sub] = String(node.artifact_kind).split(':');
        try {
          const rows = await api.artifact(runId, base, sub);
          const latest = rows?.[0];
          if (latest) {
            const payload = latest.payload_json;
            const text = typeof payload === 'string' ? payload : (payload?.markdown || payload?.content || '');
            const excerpt = text
              ? `<div class="md" style="font-size:12.4px;line-height:1.75">${markdown(text.slice(0, 1600))}</div>`
              : `<pre class="mono" style="max-height:220px;overflow:auto;white-space:pre-wrap;background:var(--card-2);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:11.5px">${esc(JSON.stringify(payload, null, 2).slice(0, 2200))}</pre>`;
            artifactHtml = `<div class="row wrap mb8" style="gap:6px">
                <span class="pill info">${esc(latest.kind)} v${esc(String(latest.version))}</span>
                <span class="mono fs11 muted">sha ${esc(String(latest.sha256 || '').slice(0, 10))}</span>
                <span class="hint fs11">${esc(latest.summary || '')}</span>
              </div>${excerpt}`;
          }
        } catch { /* 产物读取失败时保持占位 */ }
      }

      const body = `
        <div class="row wrap mb12" style="gap:6px">
          ${statusPill(node.status)}
          <span class="pill plain">${esc(node.node_type)}</span>
          <span class="pill plain">agent ${esc(node.agent_key)}</span>
          <span class="pill plain">attempt ${esc(String(node.attempt ?? 0))}</span>
          <span class="pill plain">iteration ${esc(String(node.iteration ?? 0))}</span>
          ${node.quality_score ? pill(`质量 ${node.quality_score}`, node.quality_score >= 80 ? 'ok' : 'warn') : ''}
        </div>
        <div class="field"><label>节点</label><div class="mono fs12">${esc(node.node_key)}</div></div>
        <div class="field"><label>依赖</label>
          <div class="row wrap" style="gap:6px">${(node.depends_on || []).length ? node.depends_on.map((d) => `<span class="tag">${esc(d)}</span>`).join('') : '<span class="hint">根节点（无依赖）</span>'}</div></div>
        ${node.error_code || node.error_message ? `<div class="card" style="border-left:3px solid var(--danger);background:var(--danger-soft)">
            <div class="card-title danger-text">执行错误</div>
            <div class="mono fs11 mt4">${esc(node.error_code || '')}</div>
            <p class="fs12 mt4">${esc(node.error_message || '')}</p></div>` : ''}
        ${node.feedback ? `<div class="card" style="border-left:3px solid var(--accent);background:var(--accent-soft)">
            <div class="card-title">人工/质量反馈</div>
            <p class="fs12 mt4">${esc(node.feedback.action || '')} · ${esc(node.feedback.comment || '')}</p>
            ${(node.feedback.targets || []).length ? `<div class="hint fs11 mt4">目标：${esc(node.feedback.targets.join('、'))}</div>` : ''}
          </div>` : ''}
        <div class="field mt12"><label>产物</label>
          <div class="fs12">${node.artifact_kind
            ? artifactHtml
            : '<span class="hint">该节点未产出文件</span>'}</div></div>
        <div class="field"><label>输出摘要（output_json，截断）</label>
          <pre class="mono" style="max-height:260px;overflow:auto;background:var(--card-2);border:1px solid var(--line);border-radius:8px;padding:10px;white-space:pre-wrap">${esc(filtered ? filtered.slice(0, 4000) : '（无输出或已在上方反馈中展示）')}</pre></div>
        ${report ? `<div class="field"><label>质量评分 · 第 ${esc(String(report.iteration))} 次</label>
          <div class="row" style="gap:14px;align-items:flex-start">
            ${scoreRing(report.total_score, 84)}
            <div class="grow stack" style="gap:6px">
              ${Object.entries(report.dimension_json || {}).map(([key, dim]) => `
                <div class="bar-row"><span class="fs11 muted" style="width:64px">${esc(dimLabel(key))}</span>
                  <div class="bar ${dim.score >= 80 ? 'jade' : dim.score >= 60 ? 'warn' : 'bad'}"><i style="width:${Math.max(0, Math.min(100, dim.score))}%"></i></div>
                  <span class="num">${dim.score}</span></div>`).join('')}
            </div>
          </div></div>` : ''}
        <div class="action-bar" style="position:static;border-radius:8px;border:1px solid var(--line);margin-top:12px;padding:10px">
          <button class="btn sm" id="node-retry" ${node.status === 'running' ? 'disabled title="节点正在执行"' : ''}>重试该节点</button>
          <button class="btn sm" id="node-skip" ${['pending', 'ready', 'failed', 'waiting_human', 'invalidated'].includes(node.status) ? '' : 'disabled title="当前状态不可跳过"'}>跳过该节点</button>
          <span class="action-note">重试会 attempt+1 并重新入队；跳过会把节点标记为已完成并推进下游。</span>
        </div>`;
      const box = drawer(`节点 · ${nodeKey}`, body, { width: 620 });
      $('#node-retry', box.body).onclick = async (event) => {
        event.currentTarget.disabled = true;
        try {
          await api.command(runId, 'retry-node', { nodeKey });
          toast('已重新入队', nodeKey, 'ok');
          box.close();
          await tick(true);
        } catch (error) {
          toast('重试失败', error.message || String(error), 'bad');
          event.currentTarget.disabled = false;
        }
      };
      $('#node-skip', box.body).onclick = async (event) => {
        if (!(await confirmDialog(`跳过节点 ${nodeKey}？跳过后视为已完成并推进下游。`, { danger: true, okText: '跳过' }))) return;
        event.currentTarget.disabled = true;
        try {
          await api.skipNode(runId, nodeKey);
          toast('节点已跳过', nodeKey, 'ok');
          box.close();
          await tick(true);
        } catch (error) {
          toast('跳过失败', error.message || String(error), 'bad');
          event.currentTarget.disabled = false;
        }
      };
    }

    async function openArtifact(kind) {
      const box = drawer(`产物 · ${kind}`, loading('读取产物内容…'), { width: 640 });
      try {
        const rows = await api.artifact(runId, kind);
        const latest = rows?.[0];
        const payload = latest?.payload_json;
        let inner;
        if (!latest) inner = emptyState('产物不存在');
        else if (typeof payload === 'string') inner = `<div class="md">${markdown(payload)}</div>`;
        else if (payload?.markdown) inner = `<div class="md">${markdown(payload.markdown)}</div>`;
        else {
          const json = JSON.stringify(payload, null, 2) || 'null';
          inner = `<pre class="mono" style="font-size:11.5px;line-height:1.6;white-space:pre-wrap;background:var(--card-2);border:1px solid var(--line);border-radius:8px;padding:10px">${esc(json.slice(0, 12000))}</pre>`;
        }
        const versions = (rows || []).map((v) => `<span class="tag">v${esc(String(v.version))} · ${esc(v.status)}</span>`).join('');
        box.body.innerHTML = `<div class="row wrap mb12" style="gap:6px">
            <span class="pill info">${esc(latest?.kind || kind)} v${esc(String(latest?.version ?? '?'))}</span>
            <span class="mono fs11 muted">sha ${esc(String(latest?.sha256 || '').slice(0, 12))}</span>
            <span class="hint">${esc(latest?.summary || '')}</span>
          </div>
          <div class="row wrap mb12" style="gap:6px">${versions}</div>
          ${inner}`;
      } catch (error) {
        box.body.innerHTML = emptyState('产物读取失败', error.message || String(error));
      }
    }

    /* ------------------------------------------------ 命令 */
    async function command(type) {
      if (type === 'cancel' && !(await confirmDialog('取消该运行？未完成节点会被跳过，待审任务作废。', { danger: true, okText: '取消运行' }))) return;
      try {
        const result = await api.command(runId, type);
        const label = { pause: '已暂停', resume: '已继续', cancel: '已取消', reconcile: '对账完成' }[type] || '命令已提交';
        toast(label, type === 'reconcile' && result?.interrupted !== undefined ? `回收 ${result.interrupted} 个中断节点` : '', 'ok');
        await tick(true);
      } catch (error) {
        toast('命令失败', error.message || String(error), 'bad');
      }
    }

    /* ------------------------------------------------ 绑定 / 轮询 */
    function bind() {
      bindDag(root, (key) => { openNode(key).catch((e) => toast('打开节点失败', e.message, 'bad')); });
      $$('[data-cmd]', root).forEach((button) => {
        button.onclick = () => command(button.dataset.cmd);
      });
      $$('[data-go]', root).forEach((button) => {
        button.onclick = () => {
          const pending = pendingReviews();
          location.hash = pending.length === 1 ? `#/reviews/${pending[0].id}` : '#/reviews';
        };
      });
      $$('[data-artifact]', root).forEach((row) => {
        row.onclick = () => openArtifact(row.dataset.artifact).catch((e) => toast('打开产物失败', e.message, 'bad'));
      });
    }

    /** 刚启动的运行到达闸门时，自动把人送到审核页（只自动跳一次） */
    function maybeOpenReview() {
      try {
        if (sessionStorage.getItem('bidcore.autoReview') !== runId) return false;
        const pending = pendingReviews();
        if (!pending.length) return false;
        sessionStorage.removeItem('bidcore.autoReview');
        toast('流程到达人工闸门', '已自动打开审核页，确认后自动继续', 'ok');
        location.hash = `#/reviews/${pending[0].id}`;
        return true;
      } catch {
        return false;
      }
    }

    async function tick(force = false) {
      if (state.busy && !force) return;
      if (state.destroyed) return;
      state.busy = true;
      try {
        await Promise.all([loadSnapshot(), loadEvents(false), loadSupervisor(), loadArtifacts(), loadQualityRows(), loadDocDownload(), loadLlmStatus(), loadTechMeta()]);
        paint();
        if (maybeOpenReview()) return;
      } catch (error) {
        if (!state.snap) {
          root.innerHTML = `<div class="card"><div class="card-title">运行加载失败</div>
            <p class="hint mt8">${esc(error.message || String(error))}</p>
            <div class="row mt12"><a class="btn sm" href="#/runs">返回运行看板</a></div></div>`;
        } else {
          toast('刷新失败', error.message || String(error), 'bad');
        }
      } finally {
        state.busy = false;
        syncTimer();
      }
    }

    function syncTimer() {
      const running = !TERMINAL.has(run().status);
      if (running && !state.timer && !state.destroyed) {
        state.timer = setInterval(() => { tick().catch(() => {}); }, POLL_MS);
      } else if (!running && state.timer) {
        clearInterval(state.timer);
        state.timer = null;
      }
    }

    /* ------------------------------------------------ 首屏 */
    root.innerHTML = loading('加载运行快照…');
    try {
      await loadSnapshot();
    } catch (error) {
      root.innerHTML = `<div class="page-head"><div><div class="page-title">运行详情</div></div></div>
        <div class="card"><div class="card-title">无法打开该运行</div>
        <p class="hint mt8">${esc(error.message || String(error))}</p>
        <div class="row mt12"><a class="btn sm" href="#/runs">返回运行看板</a></div></div>`;
      return { refresh: () => {}, destroy: () => {} };
    }
    await Promise.all([loadEvents(true), loadSupervisor(), loadArtifacts(), loadQualityRows(), loadDocDownload(), loadLlmStatus(), loadTechMeta()]);
    paint();
    maybeOpenReview();

    return {
      refresh: () => { tick().catch(() => {}); },
      destroy: () => {
        state.destroyed = true;
        if (state.timer) { clearInterval(state.timer); state.timer = null; }
      },
    };
  },
};
