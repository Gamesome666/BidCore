// 编排模板：版本列表 + 只读 DAG + 计划 JSON + 7 条校验清单（admin 可编辑并保存新版本）。
import { api } from '../lib/api.js';
import {
  $, $$, escapeHtml, pill, emptyState, loading, toast, modal, dag, dagLegend, fmtTime,
} from '../lib/ui.js';

const esc = escapeHtml;
const AGENT_KEYS = ['parse-tender', 'bid-strategy', 'knowledge', 'tech', 'commercial', 'compliance', 'quality', 'doc', 'supervisor'];
const NODE_TYPES = ['agent', 'quality', 'human-review', 'export'];

function normalizeNodes(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  return nodes.map((n) => ({
    ...n,
    depends_on: Array.isArray(n.depends_on) ? n.depends_on : [],
    status: n.status || 'pending',
  }));
}

/** 客户端校验清单（与 server/domain/planner.mjs 的 validatePlan 同口径，用于即时反馈） */
function validate(nodes) {
  const checks = [];
  const keys = nodes.map((n) => String(n.node_key || ''));
  const keySet = new Set(keys);
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);

  checks.push({ ok: nodes.length >= 3 && nodes.length <= 24, text: '节点数量 3–24 个', detail: `当前 ${nodes.length} 个` });
  checks.push({ ok: !dupes.length && keys.every((k) => /^[a-z0-9-]{1,48}$/.test(k)), text: 'node_key 合法且唯一', detail: dupes.length ? `重复：${dupes.slice(0, 3).join('、')}` : '小写字母/数字/短横线' });
  const badAgent = nodes.filter((n) => !AGENT_KEYS.includes(n.agent_key)).map((n) => n.agent_key);
  checks.push({ ok: !badAgent.length, text: 'agent_key 属于 9 个合法角色', detail: badAgent.length ? `非法：${badAgent.slice(0, 3).join('、')}` : `${new Set(nodes.map((n) => n.agent_key)).size} 个角色` });
  const badType = nodes.filter((n) => !NODE_TYPES.includes(n.node_type)).map((n) => n.node_type);
  checks.push({ ok: !badType.length, text: 'node_type 属于 agent/quality/human-review/export', detail: badType.length ? `非法：${badType.slice(0, 3).join('、')}` : '类型合法' });
  const gateMissing = nodes.filter((n) => n.node_type === 'human-review' && !n.review_policy_key).map((n) => n.node_key);
  checks.push({ ok: !gateMissing.length, text: 'human-review 必须声明 review_policy_key', detail: gateMissing.length ? `缺失：${gateMissing.slice(0, 3).join('、')}` : `${nodes.filter((n) => n.node_type === 'human-review').length} 个人工门禁` });
  const badDeps = nodes.flatMap((n) => n.depends_on.filter((d) => !keySet.has(d)));
  const indeg = new Map(nodes.map((n) => [n.node_key, n.depends_on.length]));
  const adj = new Map(nodes.map((n) => [n.node_key, []]));
  for (const n of nodes) for (const d of n.depends_on) adj.get(d)?.push(n.node_key);
  const queue = [...indeg.entries()].filter(([, v]) => v === 0).map(([k]) => k);
  let seen = 0;
  while (queue.length) {
    const k = queue.shift();
    seen += 1;
    for (const next of adj.get(k) || []) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  checks.push({ ok: !badDeps.length && seen === nodes.length, text: '依赖存在且无环', detail: badDeps.length ? `缺失依赖：${badDeps.slice(0, 3).join('、')}` : seen === nodes.length ? '拓扑有序' : '检测到环' });
  const consumed = new Set(nodes.flatMap((n) => n.depends_on));
  const hasExport = nodes.some((n) => n.node_type === 'export' && !consumed.has(n.node_key));
  checks.push({ ok: hasExport, text: '存在 export 终结点', detail: hasExport ? '可导出 Word' : '缺少导出节点' });
  return checks;
}

export default {
  title: '编排模板',

  async render(root, ctx) {
    const state = {
      defs: [],
      selectedId: '',
      loading: true,
      error: '',
      destroyed: false,
    };
    const isAdmin = ctx.user?.role === 'admin';

    const current = () => state.defs.find((d) => String(d.id) === String(state.selectedId)) || state.defs[0] || null;

    async function load() {
      try {
        state.defs = await api.workflowDefs();
        state.error = '';
      } catch (error) {
        state.error = error.message || String(error);
        state.defs = [];
      }
      if (!state.selectedId || !state.defs.some((d) => String(d.id) === String(state.selectedId))) {
        state.selectedId = state.defs[0]?.id || '';
      }
      state.loading = false;
      paint();
    }

    function versionList() {
      if (!state.defs.length) return emptyState('还没有编排模板', '种子数据会写入 default v1', '⋈');
      const groups = new Map();
      for (const def of state.defs) {
        const key = def.key || 'default';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(def);
      }
      return [...groups.entries()].map(([key, defs]) => `
        <div class="hint fs11" style="letter-spacing:.1em;text-transform:uppercase;padding:8px 6px 4px">${esc(key)}</div>
        ${defs.sort((a, b) => Number(b.version) - Number(a.version)).map((def) => `
          <button class="list-row ${String(def.id) === String(state.selectedId) ? 'active' : ''}" data-def="${esc(def.id)}"
            style="width:100%;text-align:left;background:none;border:0;border-radius:8px;cursor:pointer">
            <div class="l-main">
              <div class="l-title">v${esc(String(def.version))} <span class="hint" style="font-weight:400">${esc(def.name || '')}</span></div>
              <div class="l-sub ellipsis" style="display:block;max-width:190px">${esc(def.description || '')}</div>
            </div>
            ${def.active ? '<span class="pill ok">启用</span>' : '<span class="pill plain">停用</span>'}
          </button>`).join('')}`).join('');
    }

    function checksHtml(def) {
      const nodes = normalizeNodes(def.graph_json);
      const checks = validate(nodes);
      const pass = checks.filter((c) => c.ok).length;
      return `<div class="card">
        <div class="card-head" style="padding:0 0 10px;border:0">
          <div class="card-title">校验清单 <span class="hint" style="font-weight:400">validatePlan · 与后端同口径</span></div>
          <div class="right"><span class="pill ${pass === checks.length ? 'ok' : 'warn'}">${pass}/${checks.length} 通过</span></div>
        </div>
        <div class="stack" style="gap:6px">
          ${checks.map((c, i) => `<div class="finding ${c.ok ? 'ok' : 'bad'}" style="padding:8px 10px">
            <span class="f-code">${String(i + 1).padStart(2, '0')}</span>
            <div class="f-body"><div class="f-title">${esc(c.text)}</div>
              <div class="f-evidence">${esc(c.detail)}</div></div>
            <span class="pill ${c.ok ? 'ok' : 'bad'}" style="height:19px">${c.ok ? '通过' : '不通过'}</span>
          </div>`).join('')}
        </div>
        <div class="hint fs11 mt8">保存时后端会再跑一次 validatePlan，失败返回 <span class="mono">WF_PLAN_INVALID</span>。</div>
      </div>`;
    }

    function detail(def) {
      if (!def) return `<div class="card">${emptyState('选择左侧版本', '查看该版本的 DAG、计划 JSON 与校验结果')}</div>`;
      const nodes = normalizeNodes(def.graph_json);
      const policy = def.policy_json || {};
      const gates = nodes.filter((n) => n.node_type === 'human-review');
      return `<div class="stack-gap">
        <div class="card">
          <div class="flex-between" style="align-items:flex-start">
            <div>
              <div class="card-title">${esc(def.name || '未命名流程')} <span class="pill plain">v${esc(String(def.version))}</span>
                ${def.active ? '<span class="pill ok">启用中</span>' : ''}</div>
              <div class="card-sub">${esc(def.description || '')}</div>
            </div>
            <div class="row" style="gap:6px">
              <span class="hint fs11">创建 ${fmtTime(def.created_at)}</span>
              ${isAdmin ? '<button class="btn sm primary" data-edit-def>编辑 JSON</button>' : '<span class="pill plain">只读</span>'}
            </div>
          </div>
          <div class="row wrap mt12" style="gap:6px">
            <span class="pill plain">${nodes.length} 节点</span>
            <span class="pill accent">${gates.length} 人工门禁</span>
            <span class="pill info">并行度 ${esc(String(policy.parallelism ?? '—'))}</span>
            ${policy.max_budget?.max_tokens ? `<span class="pill plain">预算 ${Number(policy.max_budget.max_tokens).toLocaleString()} tokens</span>` : ''}
          </div>
        </div>
        <div class="card">
          <div class="card-title">执行图 <span class="hint" style="font-weight:400">自上而下 · 同层并行</span></div>
          <div class="mt12">${dag(nodes)}${dagLegend()}</div>
        </div>
        <div class="card">
          <details>
            <summary class="card-title pointer">计划 JSON（graph_json）</summary>
            <pre class="mono mt8" style="white-space:pre-wrap;background:var(--card-2);border:1px solid var(--line);border-radius:8px;padding:12px;max-height:420px;overflow:auto;font-size:11.5px">${esc(JSON.stringify({ ...def.graph_json, nodes }, null, 2))}</pre>
          </details>
          <details class="mt12">
            <summary class="card-title pointer">策略 JSON（policy_json）</summary>
            <pre class="mono mt8" style="white-space:pre-wrap;background:var(--card-2);border:1px solid var(--line);border-radius:8px;padding:12px;max-height:280px;overflow:auto;font-size:11.5px">${esc(JSON.stringify(policy, null, 2))}</pre>
          </details>
        </div>
        ${checksHtml(def)}
      </div>`;
    }

    function paint() {
      if (state.destroyed) return;
      const def = current();
      root.innerHTML = `
        <div class="page-head">
          <div>
            <div class="page-title">编排模板</div>
            <div class="page-desc">工作流的"骨架"：节点/依赖/门禁策略决定 Supervisor 的调度空间。保存会产生新版本（version+1），不影响历史运行。</div>
          </div>
          <div class="page-actions">
            <span class="pill ${isAdmin ? 'ok' : 'plain'}">${isAdmin ? '管理员：可编辑' : '只读（仅管理员可编辑）'}</span>
            <button class="btn ghost" id="wf-reload">刷新</button>
          </div>
        </div>
        ${state.loading
          ? `<div class="card">${loading('加载编排模板…')}</div>`
          : state.error
            ? `<div class="card"><div class="card-title">模板加载失败</div><p class="hint mt8">${esc(state.error)}</p>
                <button class="btn sm mt12" id="wf-reload2">重新加载</button></div>`
            : `<div style="display:grid;grid-template-columns:280px minmax(0,1fr);gap:16px;align-items:start">
                <div class="card pad-sm">${versionList()}</div>
                <div>${detail(def)}</div>
              </div>`}`;
      bind(def);
    }

    function openEditor(def) {
      if (!isAdmin) { toast('只读', '仅管理员可修改流程模板', 'warn'); return; }
      const graph = { ...def.graph_json, nodes: normalizeNodes(def.graph_json) };
      const box = modal({
        title: `编辑编排 · ${def.name} v${def.version}`,
        wide: true,
        body: `<p class="hint mb12">保存会写入 <span class="mono">v${Number(def.version) + 1}</span> 新版本。JSON 必须包含 nodes（node_key / agent_key / node_type / depends_on，human-review 需 review_policy_key）。</p>
          <div class="field"><label>名称</label><input class="input" id="wf-name" value="${esc(def.name || '')}" /></div>
          <div class="field"><label>说明</label><input class="input" id="wf-desc" value="${esc(def.description || '')}" /></div>
          <div class="field"><label>graph JSON</label>
            <textarea class="textarea" id="wf-json" style="min-height:320px;font-family:var(--mono);font-size:11.5px">${esc(JSON.stringify({ nodes: graph.nodes, budget: graph.budget, rationale: graph.rationale }, null, 2))}</textarea></div>`,
        footer: `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="wf-save">保存为新版本</button>`,
      });
      $('#wf-save', box.root).onclick = async (event) => {
        const button = event.currentTarget;
        let parsed;
        try {
          parsed = JSON.parse($('#wf-json', box.root).value);
        } catch (error) {
          toast('JSON 解析失败', error.message, 'bad');
          return;
        }
        const nodes = normalizeNodes(parsed);
        const failed = validate(nodes).filter((c) => !c.ok);
        if (failed.length) {
          toast('校验未通过', failed.map((c) => c.text).join('；'), 'warn');
          return;
        }
        button.disabled = true;
        try {
          await api.saveWorkflowDef({
            key: def.key || 'default',
            version: Number(def.version) + 1,
            name: $('#wf-name', box.root).value.trim() || def.name,
            description: $('#wf-desc', box.root).value.trim(),
            graph: { ...parsed, nodes },
            policy: def.policy_json || {},
          });
          box.close();
          toast('已保存新版本', `v${Number(def.version) + 1}`, 'ok');
          await load();
        } catch (error) {
          button.disabled = false;
          toast('保存失败', `${error.code || 'WF_PLAN_INVALID'} · ${error.message || ''}`.trim(), 'bad');
        }
      };
    }

    function bind(def) {
      $$('[data-def]', root).forEach((button) => {
        button.onclick = () => { state.selectedId = button.dataset.def; paint(); };
      });
      $$('[data-edit-def]', root).forEach((button) => {
        button.onclick = () => { if (def) openEditor(def); };
      });
      const reload = $('#wf-reload', root) || $('#wf-reload2', root);
      if (reload) reload.onclick = () => { state.loading = true; paint(); load(); };
    }

    paint();
    await load();

    return {
      refresh: () => { load().catch((error) => toast('刷新失败', error.message, 'bad')); },
      destroy: () => { state.destroyed = true; },
    };
  },
};
