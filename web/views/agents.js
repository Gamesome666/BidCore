// Agent 团队（9 角色）：职责 / 模型档 / 工具 / 提示词 / 启停。
// 口径：Supervisor 只做规划与调度（不写内容），内容由专业 Agent 产出。
import { api } from '../lib/api.js';
import {
  $, $$, escapeHtml, pill, emptyState, loading, toast, modal, fmtNum,
} from '../lib/ui.js';

const esc = escapeHtml;
const TIER = {
  strong: { label: '强模型', kind: 'violet', hint: '复杂推理：策略 / 技术方案 / 合规' },
  fast: { label: '快模型', kind: 'info', hint: '检索 / 抽取 / 格式化' },
  standard: { label: '标准', kind: 'plain', hint: '通用写作与整理' },
};
const SORTS = [
  { key: 'default', label: '按编排顺序' },
  { key: 'tier', label: '按模型档' },
  { key: 'name', label: '按名称' },
];

const avatarText = (agent) => String(agent.name || agent.id || 'A').replace(/^[^A-Za-z\u4e00-\u9fa5]*/, '').slice(0, 1) || 'A';

export default {
  title: 'Agent 团队',

  async render(root, ctx) {
    const state = { agents: [], sort: 'default', loading: true, error: '', destroyed: false };

    async function load() {
      try {
        state.agents = await api.agents();
        state.error = '';
      } catch (error) {
        state.error = error.message || String(error);
        state.agents = [];
      }
      state.loading = false;
      paint();
    }

    function sorted() {
      const list = [...state.agents];
      if (state.sort === 'tier') {
        const order = { strong: 0, standard: 1, fast: 2 };
        list.sort((a, b) => (order[a.model_tier] ?? 9) - (order[b.model_tier] ?? 9) || Number(a.sort || 0) - Number(b.sort || 0));
      } else if (state.sort === 'name') {
        list.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh-CN'));
      } else {
        list.sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0));
      }
      return list;
    }

    function card(agent) {
      const tier = TIER[agent.model_tier] || TIER.standard;
      const tools = Array.isArray(agent.tools) ? agent.tools : [];
      return `<div class="agent-card" data-agent="${esc(agent.id)}" style="${agent.enabled ? '' : 'opacity:.72'}">
        <div class="a-head">
          <div class="a-avatar" style="background:${agent.enabled ? 'var(--paper-2)' : 'var(--line)'}">${esc(avatarText(agent))}</div>
          <div style="min-width:0;flex:1">
            <div class="a-name ellipsis">${esc(agent.name)}</div>
            <div class="a-role mono ellipsis">${esc(agent.role)} · ${esc(agent.id)}</div>
          </div>
          <button class="switch" role="switch" aria-checked="${agent.enabled ? 'true' : 'false'}"
            data-toggle="${esc(agent.id)}" title="${agent.enabled ? '点击停用' : '点击启用'}"></button>
        </div>
        <div class="a-desc">${esc(agent.description || '（未填写职责）')}</div>
        <div class="row wrap mb8" style="gap:5px">
          <span class="pill ${tier.kind}" title="${esc(tier.hint)}">${tier.label}${agent.model_tier ? ` · ${esc(agent.model_tier)}` : ''}</span>
          ${tools.slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}
          ${tools.length > 4 ? `<span class="tag soft">+${tools.length - 4}</span>` : ''}
        </div>
        <div class="flex-between" style="padding-top:9px;border-top:1px dashed var(--line)">
          <span class="hint fs11">${agent.system_prompt ? `提示词 ${fmtNum(agent.system_prompt.length)} 字` : '未配置提示词'}</span>
          <div class="row" style="gap:4px">
            <button class="btn xs" data-prompt="${esc(agent.id)}">看提示词</button>
            <button class="btn xs primary" data-edit="${esc(agent.id)}">编辑</button>
          </div>
        </div>
      </div>`;
    }

    function paint() {
      if (state.destroyed) return;
      const list = sorted();
      const enabled = state.agents.filter((a) => a.enabled).length;
      const tierCount = (tier) => state.agents.filter((a) => a.model_tier === tier).length;
      root.innerHTML = `
        <div class="page-head">
          <div>
            <div class="page-title">Agent 团队</div>
            <div class="page-desc">9 个角色各司其职：<b>Supervisor 只调度不写内容</b> —— 它产出计划、按依赖并行派发、按质量/人工门禁决定返工，正文由专业 Agent 生成。<br />提示词、模型档位、工具与启停<b>在下次运行时生效</b>（运行时由引擎注入每个节点）。</div>
          </div>
          <div class="page-actions">
            <div class="segmented">
              ${SORTS.map((s) => `<button data-sort="${s.key}" class="${state.sort === s.key ? 'active' : ''}">${s.label}</button>`).join('')}
            </div>
            <button class="btn ghost" id="ag-reload">刷新</button>
          </div>
        </div>
        <div class="grid c4 mb16">
          <div class="kpi"><div class="k-label">角色总数</div><div class="k-value">${state.agents.length}<small>个</small></div>
            <div class="k-foot">Supervisor + 8 个专业 Agent</div></div>
          <div class="kpi jade"><div class="k-label">已启用</div><div class="k-value">${enabled}<small>/ ${state.agents.length || '-'}</small></div>
            <div class="k-foot">停用的 Agent 会被计划器跳过</div></div>
          <div class="kpi accent"><div class="k-label">强模型</div><div class="k-value">${tierCount('strong')}<small>个</small></div>
            <div class="k-foot">策略 / 技术 / 合规等重推理角色</div></div>
          <div class="kpi"><div class="k-label">快模型</div><div class="k-value">${tierCount('fast')}<small>个</small></div>
            <div class="k-foot">检索 / 抽取等高频轻任务</div></div>
        </div>
        ${state.loading
          ? `<div class="card">${loading('加载 Agent 配置…')}</div>`
          : state.error
            ? `<div class="card"><div class="card-title">Agent 配置加载失败</div><p class="hint mt8">${esc(state.error)}</p>
                <button class="btn sm mt12" id="ag-reload2">重新加载</button></div>`
            : list.length
              ? `<div class="grid c3">${list.map(card).join('')}</div>`
              : `<div class="card">${emptyState('还没有配置 Agent', '运行 server/seed.mjs 初始化 9 个角色', '◎')}</div>`}
        <div class="card mt16">
          <div class="card-title">模型档位说明</div>
          <div class="grid c3 mt12">
            ${Object.entries(TIER).map(([key, tier]) => `<div>
              <div class="row" style="gap:6px"><span class="pill ${tier.kind}">${tier.label}</span><span class="mono hint fs11">${key}</span></div>
              <div class="hint fs11 mt4">${esc(tier.hint)}</div>
            </div>`).join('')}
          </div>
          <div class="hint fs11 mt12">切到 mock 模式时三档行为一致（确定性写作器），切到 openai 后按 model_tier 映射到不同模型。</div>
        </div>`;
      bind();
    }

    function openPrompt(agent) {
      modal({
        title: `系统提示词 · ${agent.name}`,
        wide: true,
        body: `<pre class="mono" style="white-space:pre-wrap;background:var(--card-2);border:1px solid var(--line);border-radius:8px;padding:12px;max-height:52vh;overflow:auto">${esc(agent.system_prompt || '（未配置）')}</pre>
          <div class="hint fs11 mt8">提示词决定该 Agent 的写作口径；修改后从下一次节点执行开始生效。</div>`,
        footer: `<button class="btn" data-modal-close>关闭</button><button class="btn primary" id="prompt-edit">去编辑</button>`,
      });
      $('#prompt-edit', document.getElementById('modal-root')).onclick = () => {
        document.getElementById('modal-root').innerHTML = '';
        openEditor(agent);
      };
    }

    function openEditor(agent) {
      const tools = (Array.isArray(agent.tools) ? agent.tools : []).join(', ');
      const box = modal({
        title: `编辑 Agent · ${agent.name}`,
        wide: true,
        body: `<div class="form-grid">
            <div class="field"><label>模型档位</label>
              <select class="select" id="ag-tier">
                ${Object.entries(TIER).map(([key, tier]) => `<option value="${key}" ${agent.model_tier === key ? 'selected' : ''}>${tier.label}（${key}）</option>`).join('')}
              </select></div>
            <div class="field"><label>启用</label>
              <label class="row" style="gap:8px;height:34px"><button class="switch" role="switch" id="ag-enabled" aria-checked="${agent.enabled ? 'true' : 'false'}"></button>
                <span class="hint fs12">停用后计划器不再为该角色派单</span></label></div>
            <div class="field span2"><label>职责描述</label>
              <textarea class="textarea" id="ag-desc" style="min-height:80px">${esc(agent.description || '')}</textarea></div>
            <div class="field span2"><label>工具（逗号分隔）</label>
              <input class="input" id="ag-tools" value="${esc(tools)}" placeholder="read_tender, extract_requirements" /></div>
            <div class="field span2"><label>系统提示词</label>
              <textarea class="textarea" id="ag-prompt" style="min-height:150px">${esc(agent.system_prompt || '')}</textarea></div>
          </div>`,
        footer: `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="ag-save">保存</button>`,
      });
      let enabled = Boolean(agent.enabled);
      const toggle = $('#ag-enabled', box.root);
      toggle.onclick = () => {
        enabled = !enabled;
        toggle.setAttribute('aria-checked', enabled ? 'true' : 'false');
      };
      $('#ag-save', box.root).onclick = async (event) => {
        const button = event.currentTarget;
        const body = {
          description: $('#ag-desc', box.root).value.trim(),
          modelTier: $('#ag-tier', box.root).value,
          tools: $('#ag-tools', box.root).value.split(/[,，]/).map((t) => t.trim()).filter(Boolean),
          systemPrompt: $('#ag-prompt', box.root).value,
          enabled: enabled ? 1 : 0,
        };
        button.disabled = true;
        try {
          const saved = await api.saveAgent(agent.id, body);
          box.close();
          const idx = state.agents.findIndex((a) => String(a.id) === String(agent.id));
          if (idx >= 0) {
            state.agents[idx] = {
              ...state.agents[idx], ...body,
              model_tier: saved?.model_tier || body.modelTier,
              system_prompt: saved?.system_prompt ?? body.systemPrompt,
              enabled: saved?.enabled ?? (enabled ? 1 : 0),
              tools: Array.isArray(body.tools) ? body.tools : [],
            };
          }
          paint();
          toast('已保存', agent.name, 'ok');
        } catch (error) {
          button.disabled = false;
          toast('保存失败', `${error.code || ''} ${error.message || ''}`.trim(), 'bad');
        }
      };
    }

    function bind() {
      $$('[data-sort]', root).forEach((button) => {
        button.onclick = () => { state.sort = button.dataset.sort; paint(); };
      });
      $$('[data-edit]', root).forEach((button) => {
        button.onclick = () => {
          const agent = state.agents.find((a) => String(a.id) === button.dataset.edit);
          if (agent) openEditor(agent);
        };
      });
      $$('[data-prompt]', root).forEach((button) => {
        button.onclick = () => {
          const agent = state.agents.find((a) => String(a.id) === button.dataset.prompt);
          if (agent) openPrompt(agent);
        };
      });
      $$('[data-toggle]', root).forEach((button) => {
        button.onclick = async () => {
          const agent = state.agents.find((a) => String(a.id) === button.dataset.toggle);
          if (!agent) return;
          const next = agent.enabled ? 0 : 1;
          button.disabled = true;
          try {
            await api.saveAgent(agent.id, { enabled: next });
            agent.enabled = next;
            paint();
            toast(next ? '已启用' : '已停用', agent.name, next ? 'ok' : 'warn');
          } catch (error) {
            button.disabled = false;
            toast('切换失败', `${error.code || ''} ${error.message || ''}`.trim(), 'bad');
          }
        };
      });
      const reload = $('#ag-reload', root) || $('#ag-reload2', root);
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
