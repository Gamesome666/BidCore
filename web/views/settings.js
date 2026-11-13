// 平台设置：模型 / 质量权重 / 审核 SLA / 编排参数。保存分区提交（llm · quality · review · workflow）。
import { api } from '../lib/api.js';
import {
  $, $$, escapeHtml, pill, toast, loading, fmtRelative,
} from '../lib/ui.js';

const esc = escapeHtml;
const DIMS = [
  { key: 'requirement_coverage', label: '完整性（需求覆盖）', hint: '招标要求逐条响应' },
  { key: 'accuracy', label: '准确性', hint: '事实/参数/条款引用正确' },
  { key: 'technical_quality', label: '技术性', hint: '方案深度与可落地性' },
  { key: 'material_match', label: '匹配度', hint: '资质业绩与要求匹配' },
  { key: 'documentation', label: '规范性', hint: '编号/格式/篇幅规范' },
];

const num = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export default {
  title: '平台设置',

  async render(root, ctx) {
    const isAdmin = ctx.user?.role === 'admin';
    const state = {
      settings: null,
      status: null,
      qualityConfig: null,
      loading: true,
      error: '',
      destroyed: false,
    };

    async function load() {
      try {
        const settings = await api.settings();
        state.settings = settings;
        state.status = settings.llm_status || await api.llmStatus().catch(() => ({}));
        state.qualityConfig = await api.qualityConfig().catch(() => null);
        state.error = '';
      } catch (error) {
        state.error = error.message || String(error);
      }
      state.loading = false;
      paint();
    }

    const llm = () => state.settings?.llm || {};
    const quality = () => state.qualityConfig || state.settings?.quality || {};
    const workflow = () => state.settings?.workflow || {};
    const review = () => state.settings?.review || {};

    /* ------------------------------------------------ 模型 */
    function modelCard() {
      const cfg = llm();
      const st = state.status || {};
      const disabled = isAdmin ? '' : 'disabled';
      return `<div class="card">
        <div class="card-head" style="padding:0 0 12px;border:0">
          <div class="card-title">模型接入</div>
          <div class="right row" style="gap:6px">
            ${pill(st.mode === 'openai' ? '真实模型' : 'mock 模式', st.mode === 'openai' ? 'ok' : 'plain')}
            <span class="pill ${st.ready ? 'ok' : 'bad'}">${st.ready ? '配置就绪' : '缺少 key/base_url'}</span>
            <span class="tag">${esc(st.provider || 'mock')}</span>
          </div>
        </div>
        <div class="form-grid">
          <div class="field"><label>运行模式</label>
            <select class="select" id="set-mode" ${disabled}>
              <option value="mock" ${cfg.mode !== 'openai' ? 'selected' : ''}>mock（确定性写作器，离线可跑）</option>
              <option value="openai" ${cfg.mode === 'openai' ? 'selected' : ''}>openai（OpenAI 兼容网关）</option>
            </select>
            <div class="hint">mock 不是假数据：同一输入产出稳定文本，断网也能完整演示全链路。</div></div>
          <div class="field"><label>模型名</label>
            <input class="input" id="set-model" value="${esc(cfg.model || '')}" placeholder="deepseek-v4.1-flash" ${disabled} />
            <div class="hint">评委模型可在下方质量区单独指定。</div></div>
          <div class="field span2"><label>Base URL</label>
            <input class="input" id="set-base" value="${esc(cfg.base_url || '')}" placeholder="https://opencode.ai/inference/go/openai/v1" ${disabled} />
            <div class="hint">OpenAI 兼容网关需支持 <span class="mono">/chat/completions</span>；opencode 网关强制 <span class="mono">x-opencode-session</span>（本系统自动带上）。</div></div>
          <div class="field"><label>API Key</label>
            <input class="input" id="set-key" type="password" value="${esc(cfg.api_key || '')}" placeholder="sk-…" ${disabled} />
            <div class="hint">已保存时显示 ******，保持不变即可。</div></div>
          <div class="field"><label>Session ID</label>
            <input class="input" id="set-session" value="${esc(cfg.session_id || 'bidcore')}" ${disabled} /></div>
          <div class="field"><label>温度 temperature</label>
            <input class="input" id="set-temp" type="number" step="0.05" min="0" max="1.5" value="${num(cfg.temperature, 0.3)}" ${disabled} /></div>
          <div class="field"><label>超时（毫秒）</label>
            <input class="input" id="set-timeout" type="number" step="1000" min="5000" value="${num(cfg.timeout_ms, 90000)}" ${disabled} /></div>
        </div>
        <div class="flex-between mt8">
          <div class="hint fs11">
            ${st.base_url ? `探活目标 <span class="mono">${esc(st.base_url)}</span>` : '未配置 base_url：将始终走 mock'}
            ${st.session_id ? ` · session ${esc(st.session_id)}` : ''}
          </div>
          <div class="row" style="gap:8px">
            <button class="btn" id="set-probe">测试连接</button>
            <button class="btn primary" id="set-save-llm" ${isAdmin ? '' : 'disabled'}>保存模型配置</button>
          </div>
        </div>
      </div>`;
    }

    /* ------------------------------------------------ 质量 */
    function qualityCard() {
      const cfg = quality();
      const weights = { ...(cfg.weights || {}) };
      const sum = DIMS.reduce((acc, d) => acc + num(weights[d.key]), 0);
      const disabled = isAdmin ? '' : 'disabled';
      return `<div class="card">
        <div class="card-head" style="padding:0 0 12px;border:0">
          <div class="card-title">质量权重与阈值</div>
          <div class="right"><span class="pill ${sum === 100 ? 'ok' : 'bad'}" id="weight-sum">Σ ${sum}</span></div>
        </div>
        <div class="hint fs11 mb12">五维加权求和得到总分；权重之和必须为 100。规则引擎与受限评委 rubric 会分别产出证据，最终取确定性规则口径。</div>
        <div class="stack" style="gap:10px">
          ${DIMS.map((d) => `<div class="row" style="gap:10px">
            <div style="width:150px"><div class="fs12">${esc(d.label)}</div><div class="hint fs11">${esc(d.hint)}</div></div>
            <input class="input" style="width:96px" type="number" min="0" max="100" step="1"
              id="w-${d.key}" value="${num(weights[d.key])}" data-weight ${disabled} />
            <span class="hint fs11">分</span>
          </div>`).join('')}
        </div>
        <div class="divider"></div>
        <div class="form-grid">
          <div class="field"><label>达标线 passScore</label>
            <input class="input" id="set-pass" type="number" min="0" max="100" value="${num(cfg.passScore, 80)}" ${disabled} />
            <div class="hint">≥ 达标线：进入人工审核</div></div>
          <div class="field"><label>返工线 reviseScore</label>
            <input class="input" id="set-revise" type="number" min="0" max="100" value="${num(cfg.reviseScore, 60)}" ${disabled} />
            <div class="hint">&lt; 返工线：重新生成</div></div>
          <div class="field"><label>最大迭代</label>
            <input class="input" id="set-iter" type="number" min="1" max="8" value="${num(cfg.maxIterations, 3)}" ${disabled} /></div>
          <div class="field"><label>评委模型（留空=跟随主模型）</label>
            <input class="input" id="set-judge-model" value="${esc(cfg.judge?.model || '')}" ${disabled} /></div>
        </div>
        <div class="row wrap" style="gap:18px">
          <label class="row" style="gap:8px">
            <button class="switch" role="switch" id="set-judge" aria-checked="${cfg.judge?.enabled === false ? 'false' : 'true'}" ${disabled}></button>
            <span class="fs12">启用评委 rubric</span></label>
          <label class="row" style="gap:8px">
            <button class="switch" role="switch" id="set-two-pass" aria-checked="${cfg.judge?.two_pass ? 'true' : 'false'}" ${disabled}></button>
            <span class="fs12">两遍评委（更稳，更贵）</span></label>
          <label class="row" style="gap:8px">
            <button class="switch" role="switch" id="set-minwords" aria-checked="${cfg.thresholds?.minSectionWords ? 'true' : 'true'}" disabled></button>
            <span class="fs12 hint">最小时长 ${num(cfg.thresholds?.minSectionWords, 120)} 字 / 查重阈值 ${num(cfg.thresholds?.duplicateSimilarity, 0.72)}</span></label>
        </div>
        <div class="flex-between mt12">
          <div class="hint fs11">预算使用超过 85% 时会自动跳过第二遍评委（保结果优先）。</div>
          <button class="btn primary" id="set-save-quality" ${isAdmin ? '' : 'disabled'}>保存质量配置</button>
        </div>
      </div>`;
    }

    /* ------------------------------------------------ SLA / 编排 */
    function reviewCard() {
      const cfg = review();
      const disabled = isAdmin ? '' : 'disabled';
      const auto = cfg.allowAutoPass === true;
      return `<div class="card">
        <div class="card-head" style="padding:0 0 12px;border:0">
          <div class="card-title">审核 SLA</div>
          <div class="right"><span class="pill ${auto ? 'bad' : 'ok'}">${auto ? '允许超时自动通过' : '超时不自动通过'}</span></div>
        </div>
        <div class="form-grid">
          <div class="field"><label>提醒比例 remindRatio</label>
            <select class="select" id="set-remind" ${disabled}>
              ${[0.5, 0.75, 0.9].map((v) => `<option value="${v}" ${num(cfg.remindRatio, 0.75) === v ? 'selected' : ''}>${Math.round(v * 100)}% 时限处提醒</option>`).join('')}
            </select></div>
          <div class="field"><label>终审会签级数</label>
            <select class="select" id="set-levels" ${disabled}>
              ${[1, 2, 3].map((v) => `<option value="${v}" ${num(cfg.approvalLevels, 3) === v ? 'selected' : ''}>${v} 级${v === 1 ? '（自己确认，一个人也能跑完）' : v === 2 ? '（编制人 → 领导）' : '（项目负责人 → 商务 → 管理员）'}</option>`).join('')}
            </select>
            <div class="hint fs11">只影响 final-approval 这类「default」策略的闸门；「要求确认」始终 1 级。</div></div>
        </div>
        <label class="row" style="gap:8px;align-items:flex-start">
          <button class="switch" role="switch" id="set-autopass" aria-checked="${auto ? 'true' : 'false'}" ${disabled}></button>
          <span class="fs12">超过 SLA 自动通过
            <span class="hint" style="display:block">风险：无人把关时产物会直接进入下游，质量门禁失效；建议只在内部演练开启。</span></span>
        </label>
        <div class="flex-between mt12">
          <div class="hint fs11">超时升级/催办由后台循环扫描（remind-only / escalate 策略写在 review_policies）。</div>
          <button class="btn primary" id="set-save-review" ${isAdmin ? '' : 'disabled'}>保存审核策略</button>
        </div>
      </div>`;
    }

    function workflowCard() {
      const cfg = workflow();
      const disabled = isAdmin ? '' : 'disabled';
      return `<div class="card">
        <div class="card-head" style="padding:0 0 12px;border:0">
          <div class="card-title">编排与调度</div>
          <div class="right"><span class="pill ${cfg.enabled === false ? 'plain' : 'ok'}">${cfg.enabled === false ? '调度暂停' : '调度开启'}</span></div>
        </div>
        <div class="form-grid">
          <div class="field"><label>并行度（1–4）</label>
            <input class="input" id="set-parallel" type="number" min="1" max="4" value="${num(cfg.parallelism, 2)}" ${disabled} />
            <div class="hint">同一层可并发的节点数；过高会放大模型并发与预算。</div></div>
          <div class="field"><label>租约秒数 leaseSeconds</label>
            <input class="input" id="set-lease" type="number" min="10" max="600" value="${num(cfg.leaseSeconds, 45)}" ${disabled} />
            <div class="hint">节点占用租约超时会被对账回收并重新入队。</div></div>
          <div class="field"><label>调度扫描间隔（毫秒）</label>
            <input class="input" id="set-scan" type="number" min="200" step="100" value="${num(cfg.scanIntervalMs, 1200)}" ${disabled} /></div>
          <div class="field"><label>调度开关</label>
            <label class="row" style="gap:8px;height:34px">
              <button class="switch" role="switch" id="set-wf-enabled" aria-checked="${cfg.enabled === false ? 'false' : 'true'}" ${disabled}></button>
              <span class="hint fs12">关闭后不再自动 tick（适合备份/迁移）</span></label></div>
          <div class="field"><label>模型自定义编排</label>
            <label class="row" style="gap:8px;height:34px">
              <button class="switch" role="switch" id="set-llm-plan" aria-checked="${cfg.llm_plan === true ? 'true' : 'false'}" ${disabled}></button>
              <span class="hint fs12">关闭时固定用内置十步流程（推荐）</span></label>
            <div class="hint">开启后 Supervisor 会让模型设计节点，缺关键节点会自动回退。</div></div>
        </div>
        <div class="flex-between mt8">
          <div class="hint fs11">单实例部署：进程内定时器 + SQLite 租约，无需外部队列。</div>
          <button class="btn primary" id="set-save-wf" ${isAdmin ? '' : 'disabled'}>保存编排参数</button>
        </div>
      </div>`;
    }

    function paint() {
      if (state.destroyed) return;
      if (state.error && !state.settings) {
        root.innerHTML = `<div class="page-head"><div><div class="page-title">平台设置</div></div></div>
          <div class="card"><div class="card-title">设置加载失败</div><p class="hint mt8">${esc(state.error)}</p>
          <button class="btn sm mt12" id="set-reload">重新加载</button></div>`;
        $('#set-reload', root).onclick = () => { state.loading = true; paint(); load(); };
        return;
      }
      if (state.loading || !state.settings) {
        root.innerHTML = `<div class="page-head"><div><div class="page-title">平台设置</div></div></div>
          <div class="card">${loading('读取平台配置…')}</div>`;
        return;
      }
      root.innerHTML = `
        <div class="page-head">
          <div>
            <div class="page-title">平台设置</div>
            <div class="page-desc">模型接入、质量口径、审核 SLA 与调度参数。设置写入 settings 表，改模型后立即生效（无需重启）。</div>
          </div>
          <div class="page-actions">
            <span class="pill ${isAdmin ? 'ok' : 'plain'}">${isAdmin ? '管理员：可修改' : '只读（仅管理员可修改）'}</span>
            <span class="hint fs11">更新于 ${fmtRelative(new Date().toISOString())}</span>
          </div>
        </div>
        <div class="stack-gap">
          ${modelCard()}
          ${qualityCard()}
          <div class="grid c2" style="align-items:start">
            ${reviewCard()}
            ${workflowCard()}
          </div>
        </div>`;
      bind();
    }

    /* ------------------------------------------------ 交互 */
    function bind() {
      const toggles = {
        'set-judge': () => quality().judge?.enabled !== false,
        'set-two-pass': () => Boolean(quality().judge?.two_pass),
        'set-autopass': () => review().allowAutoPass === true,
        'set-wf-enabled': () => workflow().enabled !== false,
        'set-llm-plan': () => workflow().llm_plan === true,
      };
      for (const [id, getter] of Object.entries(toggles)) {
        const button = $(`#${id}`, root);
        if (!button || button.disabled) continue;
        button.onclick = () => {
          const next = button.getAttribute('aria-checked') !== 'true';
          button.setAttribute('aria-checked', next ? 'true' : 'false');
        };
      }

      const weightInputs = $$('[data-weight]', root);
      const syncSum = () => {
        const sum = weightInputs.reduce((acc, input) => acc + num(input.value), 0);
        const node = $('#weight-sum', root);
        if (node) {
          node.textContent = `Σ ${sum}`;
          node.className = `pill ${sum === 100 ? 'ok' : 'bad'}`;
        }
      };
      weightInputs.forEach((input) => { input.oninput = syncSum; });

      $('#set-probe', root).onclick = async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = '探测中…';
        try {
          const result = await api.post('/api/llm/probe');
          toast('连接正常', `${result?.mode || ''} ${result?.model || ''} ${result?.ms ? `${result.ms}ms` : ''}`.trim(), result?.ok === false ? 'warn' : 'ok');
        } catch (error) {
          toast('探活接口未就绪', `POST /api/llm/probe → ${error.code || error.status || ''}；保存后可在运行日志观察调用`.trim(), 'warn');
        } finally {
          button.disabled = false;
          button.textContent = '测试连接';
        }
      };

      $('#set-save-llm', root).onclick = async (event) => {
        const button = event.currentTarget;
        const body = {
          mode: $('#set-mode', root).value,
          model: $('#set-model', root).value.trim(),
          base_url: $('#set-base', root).value.trim(),
          api_key: $('#set-key', root).value.trim(),
          session_id: $('#set-session', root).value.trim(),
          temperature: num($('#set-temp', root).value, 0.3),
          timeout_ms: num($('#set-timeout', root).value, 90000),
        };
        button.disabled = true;
        try {
          const saved = await api.saveSettings({ llm: body });
          state.settings = { ...state.settings, ...(saved?.settings || {}), llm: saved?.settings?.llm || { ...llm(), ...body } };
          state.status = saved?.settings?.llm_status || state.status;
          state.loading = false;
          toast('模型配置已保存', body.mode === 'openai' ? `${body.model} @ ${body.base_url || '-'}` : 'mock 模式', 'ok');
          paint();
          // 保存后立刻探活：模型名不被服务端接受时当场报错，避免“以为接上了、正文却回退模板”
          if (body.mode === 'openai') {
            try {
              const probe = await api.llmProbe();
              if (probe && probe.ok === false) {
                toast('模型不可用', String(probe.error || '').slice(0, 160), 'bad');
              }
            } catch { /* 探活失败不影响保存 */ }
          }
        } catch (error) {
          button.disabled = false;
          toast('保存失败', `${error.code || ''} ${error.message || ''}`.trim(), 'bad');
        }
      };

      $('#set-save-quality', root).onclick = async (event) => {
        const button = event.currentTarget;
        const weights = {};
        for (const dim of DIMS) weights[dim.key] = num($(`#w-${dim.key}`, root).value);
        const sum = DIMS.reduce((acc, d) => acc + weights[d.key], 0);
        const passScore = num($('#set-pass', root).value, 80);
        const reviseScore = num($('#set-revise', root).value, 60);
        if (sum !== 100) { toast('权重之和不等于 100', `当前 Σ=${sum}，请调整后再保存`, 'warn'); return; }
        if (reviseScore >= passScore) { toast('阈值顺序错误', '返工线必须低于达标线', 'warn'); return; }
        const body = {
          ...quality(),
          weights,
          passScore,
          reviseScore,
          maxIterations: num($('#set-iter', root).value, 3),
          judge: {
            ...(quality().judge || {}),
            enabled: $('#set-judge', root).getAttribute('aria-checked') === 'true',
            two_pass: $('#set-two-pass', root).getAttribute('aria-checked') === 'true',
            model: $('#set-judge-model', root).value.trim(),
          },
        };
        button.disabled = true;
        try {
          await api.saveSettings({ quality: body });
          state.qualityConfig = body;
          state.settings = { ...state.settings, quality: body };
          toast('质量配置已保存', `Σ=100 · 达标 ${passScore} / 返工 ${reviseScore}`, 'ok');
          paint();
        } catch (error) {
          button.disabled = false;
          toast('保存失败', `${error.code || 'QUALITY_CONFIG_INVALID'} · ${error.message || ''}`.trim(), 'bad');
        }
      };

      $('#set-save-review', root).onclick = async (event) => {
        const button = event.currentTarget;
        const body = {
          ...review(),
          remindRatio: num($('#set-remind', root).value, 0.75),
          approvalLevels: num($('#set-levels', root).value, 3),
          allowAutoPass: $('#set-autopass', root).getAttribute('aria-checked') === 'true',
        };
        button.disabled = true;
        try {
          await api.saveSettings({ review: body });
          state.settings = { ...state.settings, review: body };
          toast('审核策略已保存', `终审 ${body.approvalLevels} 级${body.allowAutoPass ? ' · 已开启超时自动通过（注意风险）' : ' · 超时不自动通过'}`, body.allowAutoPass ? 'warn' : 'ok');
          paint();
        } catch (error) {
          button.disabled = false;
          toast('保存失败', `${error.code || ''} ${error.message || ''}`.trim(), 'bad');
        }
      };

      $('#set-save-wf', root).onclick = async (event) => {
        const button = event.currentTarget;
        const parallelism = Math.max(1, Math.min(4, num($('#set-parallel', root).value, 2)));
        const body = {
          ...workflow(),
          parallelism,
          leaseSeconds: num($('#set-lease', root).value, 45),
          scanIntervalMs: num($('#set-scan', root).value, 1200),
          enabled: $('#set-wf-enabled', root).getAttribute('aria-checked') === 'true',
          llm_plan: $('#set-llm-plan', root).getAttribute('aria-checked') === 'true',
        };
        button.disabled = true;
        try {
          await api.saveSettings({ workflow: body });
          state.settings = { ...state.settings, workflow: body };
          toast('编排参数已保存', `并行度 ${parallelism} · 租约 ${body.leaseSeconds}s`, 'ok');
          paint();
        } catch (error) {
          button.disabled = false;
          toast('保存失败', `${error.code || ''} ${error.message || ''}`.trim(), 'bad');
        }
      };
    }

    paint();
    await load();

    return {
      refresh: () => { load().catch((error) => toast('刷新失败', error.message, 'bad')); },
      destroy: () => { state.destroyed = true; },
    };
  },
};
