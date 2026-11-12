// LLM 接入层：mock（默认，离线可跑、确定性） / openai-compatible（真实模型）。
// 设计原则：Agent 的"结构"由代码决定，模型只负责"文字"。所以 mock 模式不是假数据，
// 而是一个可复现的写作器——评委演示时断网也能完整跑通全链路。
import { all, get, jparse } from '../db.mjs';

/**
 * 配置优先级：settings 表中的非空值 > 环境变量（.env 由 lib/env.mjs 注入）> 默认值。
 * 这样运营在设置页改模型立即生效，同时首次启动用 .env 即可跑真实模型，无需先写库。
 */
export function getLlmConfig() {
  const row = get("SELECT value_json FROM settings WHERE key='llm'");
  const stored = jparse(row?.value_json, {});
  const env = {
    mode: process.env.LLM_MODE || (process.env.LLM_API_KEY ? 'openai' : 'mock'),
    base_url: process.env.LLM_BASE_URL || '',
    api_key: process.env.LLM_API_KEY || '',
    model: process.env.LLM_MODEL || 'deepseek-v4.1-flash',
    session_id: process.env.LLM_SESSION_ID || 'bidcore',
    temperature: Number(process.env.LLM_TEMPERATURE || 0.3),
    timeout_ms: Number(process.env.LLM_TIMEOUT_MS || 90000),
  };
  const cfg = { ...env };
  for (const [key, value] of Object.entries(stored || {})) {
    if (value === undefined || value === null || value === '') continue;
    cfg[key] = value;
  }
  if (!cfg.api_key) cfg.mode = 'mock';
  if (!cfg.session_id) cfg.session_id = env.session_id;
  return cfg;
}

export function llmStatus() {
  const cfg = getLlmConfig();
  return {
    mode: cfg.mode,
    model: cfg.model,
    provider: /opencode\.ai/.test(String(cfg.base_url)) ? 'opencode-gateway' : (cfg.base_url ? 'openai-compatible' : 'mock'),
    base_url: cfg.base_url ? cfg.base_url.replace(/\/\/.*@/, '//') : '',
    session_id: cfg.session_id || '',
    ready: cfg.mode === 'mock' || Boolean(cfg.base_url && cfg.api_key),
  };
}

async function callOpenAI(cfg, messages, { json = false, temperature } = {}) {
  const url = `${String(cfg.base_url).replace(/\/$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.api_key}`,
      // OpenCode 网关强制：缺失会 400 MissingSessionID；值只需非空
      'x-opencode-session': cfg.session_id || 'bidcore',
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: temperature ?? cfg.temperature ?? 0.3,
      // 该网关的 DS 模型带 reasoning_content，token 预算太小会导致 content 为空（finish_reason=length）
      max_tokens: Number(cfg.max_tokens || 3000),
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(Number(cfg.timeout_ms || 90_000)),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const message = data?.choices?.[0]?.message || {};
  // 少数情况下模型只填了 reasoning_content；宁可返回推理文本也不要返回空串
  return message.content || message.reasoning_content || '';
}

/** 探活：真实打一次最小请求，用于设置页"测试连接"和启动自检 */
export async function probeLlm() {
  const cfg = getLlmConfig();
  if (cfg.mode === 'mock') return { ok: true, mode: 'mock', model: 'deterministic-mock' };
  const started = Date.now();
  try {
    const content = await callOpenAI(cfg, [{ role: 'user', content: '只回复两个字符：OK' }], { temperature: 0, timeout_ms: 20000 });
    return { ok: true, mode: cfg.mode, model: cfg.model, ms: Date.now() - started, sample: String(content).slice(0, 40) };
  } catch (error) {
    return { ok: false, mode: cfg.mode, model: cfg.model, ms: Date.now() - started, error: String(error.message || error) };
  }
}

/**
 * 结构化输出（评委 / 策略 / 计划）。
 * - fallback：离线或失败时的确定性兜底值
 * - mock：兼容旧调用点（函数形式），优先级高于 fallback
 */
export async function generateJson({ system, user, fallback = null, mock }) {
  const offline = () => (typeof mock === 'function' ? mock() : fallback);
  const cfg = getLlmConfig();
  if (cfg.mode !== 'openai' || !cfg.base_url || !cfg.api_key) return offline();
  try {
    const text = await callOpenAI(cfg, [
      { role: 'system', content: `${system || '你是严谨的评审专家。'}\n只输出 JSON，不要 markdown 代码块。` },
      { role: 'user', content: user },
    ], { json: true, temperature: 0 });
    const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return offline();
  }
}

/** 生成一段"有信息量"的中文正文（mock 模式由结构化要点拼装，不编造事实） */
export function mockProse({ heading, points = [], numbers = [], refs = [], bidder = '我方' }) {
  const p = points.filter(Boolean);
  let seed = 0;
  for (const ch of String(heading)) seed = (seed * 31 + ch.codePointAt(0)) % 100000;

  const openings = [
    `针对${heading}，${bidder}建立专项工作机制，明确责任人、交付物与验收口径，确保招标要求逐条落地。`,
    `在${heading}方面，${bidder}按"计划—执行—检查—改进"闭环组织工作，所有承诺均可在运行记录中核验。`,
    `${heading}是本项目的重点交付内容之一。${bidder}结合同类政务云项目经验，给出可执行、可度量的实施安排。`,
    `围绕${heading}，${bidder}从组织、流程、工具三个层面同步推进，避免出现职责空转与响应断点。`,
  ];
  const mechanisms = [
    '执行层面设置值守责任人、备份责任人与升级路径，异常按事件等级触发响应。',
    '过程管理采用标准化作业单与检查清单，关键动作留痕，月度形成运行报告。',
    '质量保障以指标驱动：可用性、响应时长、恢复时长均纳入周度看板与月度复盘。',
    '协同机制上，与采购人建立周例会与专项沟通通道，重大变更提前报备并留存记录。',
  ];
  const closings = [
    '上述安排已在本单位既有政务云项目中验证可行，可根据现场情况进一步细化。',
    '相关资源与人员均已就位，中标后可在一个月内完成交接并进入稳定运行状态。',
    '执行过程中如出现偏差，将按纠偏机制在 3 个工作日内提交整改方案并跟踪闭环。',
    '所有交付物按季度归档，形成可追溯的服务档案，供采购人随时抽查。',
  ];
  const numText = numbers.length ? `关键指标承诺：${numbers.join('、')}。` : '';
  const refText = refs.length ? `（依据：${refs.join('、')}）` : '';
  const pointText = p.length
    ? `具体包括：${p.slice(0, 5).map((x, i) => `${i + 1}) ${x}`).join('；')}。`
    : '方案覆盖服务范围、执行流程与质量保障三个层面。';

  return [
    openings[seed % openings.length],
    `${pointText}${mechanisms[(seed >> 3) % mechanisms.length]}`,
    `${numText}${closings[(seed >> 5) % closings.length]}${refText}`,
  ].join('\n\n');
}

/** 通用文本生成：mock → 结构化拼装；openai → 真实调用 */
export async function generateText({ system, user, fallback }) {
  const cfg = getLlmConfig();
  if (cfg.mode !== 'openai' || !cfg.base_url || !cfg.api_key) {
    return fallback ?? mockProse({ heading: '本项工作' });
  }
  try {
    return await callOpenAI(cfg, [
      { role: 'system', content: system || '你是中文投标文件写作专家，输出严谨、可核验的技术标内容。' },
      { role: 'user', content: user },
    ]);
  } catch (error) {
    // 真实模型失败时降级到 mock，保证工作流不中断（并在事件里可见）
    return `${fallback ?? mockProse({ heading: '本项工作' })}\n\n<!-- LLM_FALLBACK: ${String(error.message).slice(0, 120)} -->`;
  }
}


export function listAgentsForContext(keys) {
  const rows = all('SELECT * FROM agents WHERE enabled=1 ORDER BY sort');
  if (!keys?.length) return rows;
  return rows.filter((r) => keys.includes(r.id));
}

