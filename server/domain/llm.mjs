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

async function callOpenAI(cfg, messages, { json = false, temperature, model, maxTokens, timeoutMs } = {}) {
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
      model: model || cfg.model,
      messages,
      temperature: temperature ?? cfg.temperature ?? 0.3,
      // 该网关的 DS 模型带 reasoning_content，token 预算太小会导致 content 为空（finish_reason=length）
      max_tokens: Number(maxTokens || cfg.max_tokens || 3000),
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(Number(timeoutMs || cfg.timeout_ms || 90_000)),
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

/** 章节主题句库：mock 模式按章节标题给“方案性内容”，不再把招标原文贴进正文 */
const CHAPTER_THEMES = [
  {
    match: /总体|架构|微服务|技术路线/,
    lines: [
      '总体架构采用分层设计：接入层统一协议适配，平台层承载服务注册、配置与网关，数据层按主题域划分存储，应用层以微服务方式拆分建设内容。',
      '服务拆分遵循单一职责与限界上下文原则，按建设内容划分子系统，服务之间通过 API 网关通信，接口契约先行、版本可回滚。',
      '部署上支持容器化与国产化基础环境适配，数据库、中间件、操作系统均在适配清单内，避免单一厂商锁定。',
    ],
  },
  {
    match: /数据|中台|治理|迁移|标准/,
    lines: [
      '数据治理按“标准—主数据—元数据—质量”四层推进：先统一数据标准与编码规则，再建立主数据管理，元数据登记到资产目录，质量规则按月稽核。',
      '数据迁移分摸底、映射、试迁、正式迁移四步，每一步产出核对报告；迁移窗口与业务低峰对齐，失败可按批次回退。',
      '对外提供数据服务时统一走数据接口，明确口径、更新频率与责任部门，避免同一指标多口径并存。',
    ],
  },
  {
    match: /物联|接入|网关|边缘/,
    lines: [
      '物联接入采用“边缘网关 + 协议适配”的方式：边缘侧完成设备接入、协议转换与本地缓存，平台侧统一设备模型与指令下发。',
      '设备接入前先做型号与协议清单确认，逐类完成联调；断网时边缘侧缓存数据，恢复后按时间序补传，保证数据不丢。',
      '设备与网关的固件版本纳入台账管理，升级前在试点区域验证，确认兼容后再批量推送。',
    ],
  },
  {
    match: /安全|等保|加固|合规/,
    lines: [
      '安全建设对标等保 2.0 三级：从安全通信网络、安全区域边界、安全计算环境、安全管理中心四个方面逐项落实。',
      '边界部署访问控制与入侵防护，计算环境启用主机加固、恶意代码防范与审计，重要数据加密存储并按角色授权访问。',
      '上线前完成漏洞扫描与渗透测试，高危问题清零后方可上线；运行期按季度复测，问题纳入整改台账闭环。',
    ],
  },
  {
    match: /运维|SLA|值守|保障|售后/,
    lines: [
      '运维采用“一线值守—二线专家—三线厂商”的分级支持：一线负责监控与常规处置，二线处理复杂故障，三线对接原厂。',
      'SLA 以可用性、响应时长、恢复时长三项度量，监控覆盖主机、数据库、中间件与业务接口，告警按等级分派到人。',
      '每月出具运行报告，包含容量、性能、告警与改进建议；季度复盘一次，对高频故障做根因分析。',
    ],
  },
  {
    match: /团队|人员|组织|培训/,
    lines: [
      '项目组织设项目经理、技术负责人、实施与运维四类角色，职责与交付物在启动会上书面确认，避免职责交叉。',
      '关键岗位按招标要求配置证书与经验，进场前完成背景与资质核对；驻场人员按排班表轮值，保证现场始终有责任人。',
      '培训分管理员、业务人员、运维人员三类，采用集中授课加现场带教，培训后考核并形成记录。',
    ],
  },
  {
    match: /进度|计划|里程碑|实施/,
    lines: [
      '实施按“准备—开发—集成—试运行—验收”五阶段推进，每阶段设定可检查的里程碑与交付物。',
      '关键路径上的任务提前识别，资源与外部依赖在计划中显式标注；偏差超过一周即启动纠偏，必要时调整后续排期。',
      '试运行期保留回退方案，重大问题可在约定时限内切回原系统，确保业务不中断。',
    ],
  },
  {
    match: /风险|质量|改进/,
    lines: [
      '风险按技术、进度、人员、外部依赖四类建立清单，逐项标注概率、影响与责任人，每月更新。',
      '质量保障设置三道关卡：自检、交叉评审、验收评审；每道关卡有检查表与签字记录，未通过不得进入下一阶段。',
      '对反复出现的问题做根因分析，形成改进项并纳入下一轮计划，避免同类问题重复发生。',
    ],
  },
  {
    match: /演示|答辩/,
    lines: [
      '演示环境按生产同构搭建，准备完整演示数据；演示脚本覆盖主要业务链路与关键功能点，控制在规定时长内。',
      '演示前完成两轮彩排，确认账号、网络与数据可用；演示中按脚本推进，异常时切换到备用环境。',
    ],
  },
  {
    match: /知识库|文档|沉淀/,
    lines: [
      '文档体系按需求、设计、部署、运维、测试五类建立模板，交付前统一评审与归档。',
      '运维知识库沉淀故障处置手册与常见问题，按季度更新，与监控告警关联，便于一线快速定位。',
    ],
  },
];

/** 生成一段"有信息量"的中文正文（mock 模式按章节主题拼装，不复述招标原文、不编造事实） */
export function mockProse({ heading, points = [], numbers = [], refs = [], bidder = '我方' }) {
  let seed = 0;
  for (const ch of String(heading)) seed = (seed * 31 + ch.codePointAt(0)) % 100000;
  const theme = CHAPTER_THEMES.find((item) => item.match.test(String(heading)));
  const lines = theme ? theme.lines : [
    '本节围绕该章节的交付目标组织内容，明确责任人、实施步骤与验收口径。',
    '执行过程按计划、执行、检查、改进的循环推进，关键动作留痕，结果可核验。',
  ];
  const opening = `${heading}是本次建设的组成部分，${bidder}按可落地、可度量、可追溯的原则组织本节内容。`;
  const body = [opening, ...lines];
  const numText = numbers.length ? `关键指标承诺：${numbers.join('、')}。` : '';
  const refText = refs.length ? `（相关证明材料见：${refs.join('、')}）` : '';
  const closing = numText || refText ? `${numText}${refText}` : '';
  return [...body, closing].filter(Boolean).join('\n\n');
}

/**
 * 模型档位 → 实际模型。
 * strong（策略/技术/合规/总控）走主模型；fast / standard（检索/商务/质检/文档）走轻量模型，
 * 未单独配置 judge 模型时回落主模型，保证只有一套密钥也能跑。
 */
export function modelForTier(tier) {
  const cfg = getLlmConfig();
  const strong = cfg.model || 'deepseek-v4.1-flash';
  const light = cfg.judge_model || process.env.LLM_JUDGE_MODEL || strong;
  return tier === 'fast' || tier === 'standard' ? light : strong;
}

/** 是否启用真实模型（决定要不要逐章生成、要不要补写） */
export function llmEnabled() {
  const cfg = getLlmConfig();
  return cfg.mode === 'openai' && Boolean(cfg.base_url) && Boolean(cfg.api_key);
}

/** 通用文本生成：mock → 结构化拼装；openai → 真实调用（支持按 Agent 档位选模型） */
export async function generateText({ system, user, fallback, tier = 'standard', maxTokens, timeoutMs }) {
  const cfg = getLlmConfig();
  if (cfg.mode !== 'openai' || !cfg.base_url || !cfg.api_key) {
    return fallback ?? mockProse({ heading: '本项工作' });
  }
  try {
    return await callOpenAI(cfg, [
      { role: 'system', content: system || '你是中文投标文件写作专家，输出严谨、可核验的技术标内容。' },
      { role: 'user', content: user },
    ], { model: modelForTier(tier), maxTokens, timeoutMs });
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

