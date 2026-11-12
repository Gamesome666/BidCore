// 种子数据：首次启动写入演示账号/项目/知识库/Agent/工作流模板。
// 先加载 .env，保证独立执行 reset 时也能把真实模型配置写进 settings。
import './lib/env.mjs';
// 演示种子：2 个真实感招标项目 + 企业知识库（四库）+ 9 个 Agent + 默认 DAG + 三级审核策略 + 质量/模型配置。
// 目标：评委解压即跑，且能演示「缺资质 → 返工」「废标 → 强制人工」「多级审核」「Self-Loop」全部路径。
import { all, get, run, tx, jstr } from './db.mjs';
import { id, nowIso, hashPassword } from './lib/util.mjs';

export const TENDER_TEXT = `# XX市政务云平台运维服务项目 招标文件

采购编号：ZWY-2026-0117
采购人：XX市大数据管理局
代理机构：XX市政府采购中心
项目名称：XX市政务云平台运维服务项目
预算金额：人民币 480 万元（最高限价 480 万元，超过作无效投标）
服务期限：合同签订之日起 12 个月
项目地点：XX市政务云数据中心（A 机房、B 机房双活）
投标截止：2026-12-18 09:30

## 一、项目概述
本项目为 XX市政务云平台提供年度运维服务，覆盖云主机、容器平台、分布式数据库、对象存储与网络安全设备，保障 120 余个政务业务系统稳定运行。投标人需具备完整的运维服务体系、驻场团队、应急响应能力与等保合规支撑经验。

## 二、技术需求
1. 提供 7×24 小时运维值守，一般故障响应时间不超过 30 分钟，重大故障 2 小时内恢复；提供值班表与升级路径。
2. 云平台可用性不低于 99.9%，每月 5 个工作日内出具运行报告，含容量、性能、告警与改进建议。
3. 提供不少于 3 人的驻场运维团队，其中项目经理 1 名、系统工程师 2 名；项目经理需常驻本地。
4. 建立运维知识库，沉淀故障处置手册不少于 50 篇，每季度更新不少于 10 篇。
5. 提供安全加固与等保 2.0 三级合规支撑服务，配合年度测评并完成整改闭环。
6. 每季度开展一次应急演练并提交演练报告，每年至少一次双活切换演练。
7. 提供国产化适配支持：麒麟操作系统、达梦数据库、鲲鹏服务器的巡检与故障处置能力。
8. 提供运维管理平台，具备 CMDB、工单、监控告警、SLA 统计四类能力，并向采购人开放查询账号。

## 三、资格要求
1. 投标人须具备 ISO9001 质量管理体系认证（有效期内）。
2. 投标人须具备 ISO27001 信息安全管理体系认证（有效期内）。
3. 投标人须具备 CMMI 3 级及以上认证（有效期内）。
4. 近三年至少完成 2 个合同金额 200 万元以上的政务云或政务数据平台运维项目，提供合同关键页与验收证明。
5. 项目经理须具备 PMP 或信息系统项目管理师证书，且具备 5 年以上运维项目管理经验。
6. 投标人须具备 ITSS 信息技术服务运行维护标准符合性证书（二级及以上）。

## 四、商务要求
1. 报价须包含一年运维服务全部费用（含驻场人员、工具、差旅、税费），不得另行计费。
2. 付款方式：按季度支付，每季度验收合格后 30 日内支付当季款项。
3. 投标保证金：人民币 5 万元，须在投标截止时间前到账。
4. 履约保证金：合同金额的 5%，签订合同前提交。
5. 服务响应：合同签订后 10 个工作日内完成团队进场与交接。

## 五、评分办法（综合评分法，满分 100 分）
1. 技术方案（45 分）：运维方案完整性（15）、故障处置流程（10）、应急演练方案（10）、国产化适配能力（10）。
2. 服务能力（25 分）：团队配置与人员资质（12）、本地化服务能力（8）、运维平台能力（5）。
3. 商务报价（20 分）：报价合理性，基准价为有效报价平均值。
4. 企业业绩（10 分）：类似项目业绩，每个 2 分，最多 10 分。

## 六、废标条款
1. 未按要求提交投标保证金的，作废标处理。
2. 资格要求任一项不满足或证书过期的，作废标处理。
3. 技术方案未响应"7×24 小时值守"或"30 分钟响应"或"2 小时恢复"的，作废标处理。
4. 报价超过最高限价或低于成本价的，作废标处理。
5. 未按要求提交偏离表的，作废标处理。
`;

export const TENDER_TEXT_HOSPITAL = `# XX市智慧医院信息系统运维项目 招标文件（节选）

采购编号：YY-2026-0042
采购人：XX市第一人民医院
预算金额：人民币 320 万元
服务期限：12 个月

## 一、项目概述
为医院 HIS、EMR、LIS、PACS 等核心系统提供运维服务，要求 7×24 值守、门诊高峰时段现场保障、数据安全与等保三级合规。

## 二、技术需求
1. 核心业务系统可用性不低于 99.95%，门诊高峰（07:30-17:30）现场值守。
2. 故障响应 15 分钟内到场，核心系统故障 1 小时内恢复。
3. 提供 2 人驻场团队，具备 Oracle/达梦数据库与虚拟化运维能力。
4. 每季度开展一次容灾演练，提供演练报告。
5. 配合医院完成电子病历评级与互联互通测评的技术支撑。

## 三、资格要求
1. 具备 ISO27001 认证。
2. 近三年完成 2 个三级医院信息系统运维项目。
3. 项目经理具备 PMP 或系统集成项目管理工程师证书。

## 四、评分办法
技术方案 50 分、服务能力 25 分、商务报价 15 分、业绩 10 分。

## 五、废标条款
1. 未响应 7×24 值守或 15 分钟到场的，作废标处理。
2. 资格要求不满足的，作废标处理。
`;

const KNOWLEDGE = [
  { library: 'company', title: 'ISO9001 质量管理体系认证证书', folder: '公司资质', category: 'qualification', file_name: 'ISO9001-2024.pdf', content: '智标科技有限公司通过 ISO9001:2015 质量管理体系认证，认证范围包含信息技术服务与运维服务，证书编号 CN-ISO9001-2024-0812，有效期至 2027-08-11。', tags: 'ISO9001,质量管理体系,资质', expires_at: '2027-08-11' },
  { library: 'company', title: 'ISO27001 信息安全管理体系认证证书', folder: '公司资质', category: 'qualification', file_name: 'ISO27001-2023.pdf', content: '智标科技有限公司通过 ISO/IEC 27001:2022 信息安全管理体系认证，覆盖云平台运维与数据处理服务，证书编号 CN-ISO27001-2023-1105，有效期至 2027-12-05。', tags: 'ISO27001,信息安全,资质', expires_at: '2027-12-05' },
  { library: 'company', title: 'CMMI 3 级评估证书', folder: '公司资质', category: 'qualification', file_name: 'CMMI3-2025.pdf', content: '智标科技有限公司通过 CMMI DEV 3 级评估，评估范围覆盖软件开发与运维服务交付过程，证书有效期至 2028-03-20。', tags: 'CMMI3,软件能力成熟度,资质', expires_at: '2028-03-20' },
  { library: 'company', title: 'ITSS 信息技术服务运行维护标准符合性证书（二级）', folder: '公司资质', category: 'qualification', file_name: 'ITSS-2-2025.pdf', content: '智标科技有限公司取得 ITSS 运行维护服务能力成熟度二级证书，证书编号 ITSS-2025-0231，有效期至 2027-05-30。', tags: 'ITSS,运维标准,资质', expires_at: '2027-05-30' },
  { library: 'company', title: '安全生产许可证（旧版，已过期）', folder: '公司资质', category: 'qualification', file_name: 'safety-old.pdf', content: '旧版安全生产许可证，证书编号 AQ-2021-0099，有效期至 2024-12-31，已换证（新证待归档）。', tags: '安全,过期,待更新', expires_at: '2024-12-31' },
  { library: 'doc', title: 'XX市大数据局政务云运维服务项目（2024）', folder: '项目业绩', category: 'case', file_name: 'perf-zwy-2024.docx', content: '2024 年中标 XX市大数据局政务云运维服务项目，合同金额 268 万元，服务内容包含 7×24 值守、云平台巡检、故障处置与等保加固，年度可用性 99.95%，客户满意度 98%，验收结论优秀。', tags: '政务云,运维,业绩,7×24' },
  { library: 'doc', title: 'XX区数据共享平台运维项目（2023）', folder: '项目业绩', category: 'case', file_name: 'perf-data-2023.docx', content: '2023 年承接 XX区数据共享平台运维项目，合同金额 215 万元，提供驻场 3 人团队、数据库优化与安全加固服务，重大故障平均恢复时间 78 分钟。', tags: '数据平台,运维,业绩,驻场' },
  { library: 'doc', title: 'XX市医保云平台运维项目（2025）', folder: '项目业绩', category: 'case', file_name: 'perf-medical-2025.docx', content: '2025 年承接 XX市医保云平台运维项目，合同金额 236 万元，覆盖 7×24 值守、双活切换演练与等保测评整改，全年零重大事故。', tags: '医保云,业绩,双活' },
  { library: 'personnel', title: '项目经理 张伟 · PMP / 信息系统项目管理师', folder: '人员资质', category: 'personnel', file_name: 'zhangwei-pmp.pdf', content: '张伟，信息系统项目管理师、PMP，8 年政务云运维项目管理经验，主持 3 个 200 万元以上运维项目，证书有效期至 2028-06-30。', tags: 'PMP,项目经理,人员', expires_at: '2028-06-30' },
  { library: 'personnel', title: '系统工程师 李强 · RHCE / 达梦 DCP', folder: '人员资质', category: 'personnel', file_name: 'liqiang-rhce.pdf', content: '李强，RHCE 认证工程师，达梦 DCP 认证，熟悉 K8s、OpenStack、国产化数据库运维，参与 2 个政务云项目驻场，证书有效期至 2027-01-15。', tags: 'RHCE,系统工程师,K8s,达梦', expires_at: '2027-01-15' },
  { library: 'personnel', title: '系统工程师 王敏 · 麒麟操作系统认证', folder: '人员资质', category: 'personnel', file_name: 'wangmin-kylin.pdf', content: '王敏，麒麟操作系统高级运维认证、华为鲲鹏计算认证，负责国产化适配与性能调优，参与 1 个政务云项目，证书有效期至 2027-09-20。', tags: '麒麟,鲲鹏,国产化', expires_at: '2027-09-20' },
  { library: 'tool', title: '智能运维监控平台（自研工具）', folder: '工具资产', category: 'tool', file_name: 'ops-platform.md', content: '自研智能运维监控平台，支持 2000+ 指标采集、告警收敛、故障自愈编排，具备 CMDB、工单、SLA 统计模块，已取得软件著作权（2024SR0456789），在 3 个政务云项目中落地。', tags: '监控平台,自研,软著,告警,CMDB' },
  { library: 'tool', title: '运维知识库系统（自研工具）', folder: '工具资产', category: 'tool', file_name: 'kb-system.md', content: '自研运维知识库系统，支持故障处置手册结构化沉淀、相似案例检索与版本管理，当前沉淀手册 86 篇，季度更新 15 篇以上。', tags: '知识库,自研,手册' },
  { library: 'doc', title: '政务云运维服务方案模板', folder: '方案模板', category: 'template', file_name: 'ops-template.docx', content: '标准运维服务方案模板，包含服务范围、组织架构、服务流程（事件/问题/变更/发布）、SLA 指标、应急预案、知识库运营、质量保障七章，可复用为技术标主体结构。', tags: '方案模板,运维,SLA,应急预案' },
  { library: 'doc', title: '等保 2.0 三级合规支撑服务说明', folder: '方案模板', category: 'template', file_name: 'djbh-template.docx', content: '等保 2.0 三级合规支撑服务包含差距分析、整改建议、测评配合、安全加固四阶段，配套 32 项检查清单与整改台账模板。', tags: '等保2.0,合规,安全加固' },
  { library: 'doc', title: '双活数据中心切换演练脚本', folder: '方案模板', category: 'template', file_name: 'drill-script.md', content: '双活切换演练脚本包含切换前检查（28 项）、切换步骤（14 步）、回切验证（9 项）与演练报告模板，已在 2 个项目执行。', tags: '双活,演练,切换' },
];

const AGENTS = [
  ['parse-tender', '招标分析 Agent', 'tender-analyst', '解析招标文件，抽取资格/技术/商务要求与废标条款', 'strong', '["read_tender","extract_requirements"]', '你是资深投标分析师，负责把招标文件拆解为结构化要求清单，标注条款类型与风险等级。'],
  ['knowledge', '知识检索 Agent', 'knowledge-retriever', '从企业知识库检索资质、业绩、人员与方案素材，并给出匹配证据', 'fast', '["search_knowledge","match_requirements"]', '你是企业知识库检索专家，只返回可溯源命中，找不到就明确报告缺口。'],
  ['bid-strategy', '投标策略 Agent', 'bid-strategist', '制定投标策略：评分点取舍、差异化亮点与风险应对', 'strong', '["read_analysis","read_knowledge"]', '你是投标策略顾问，围绕评分办法制定技术/商务策略，明确取舍与风险。'],
  ['tech', '技术方案 Agent', 'tech-writer', '生成技术标目录与正文，保证逐条响应招标要求', 'strong', '["generate_outline","write_sections","call_knowledge"]', '你是技术标主笔，按评分点组织章节，逐条响应技术要求，禁止空话与占位符。'],
  ['commercial', '商务标 Agent', 'commercial-writer', '生成商务响应、资质清单与报价说明', 'standard', '["read_qualification","build_pricing"]', '你是商务标编制专家，输出资质响应对照表与报价构成。'],
  ['compliance', '合规审查 Agent', 'compliance-auditor', '检查废标风险、响应偏离与资格满足情况', 'strong', '["check_rejection","check_deviations"]', '你是合规审查官，逐条核对废标条款与资格要求，缺一即报 veto。'],
  ['quality', '质量评估 Agent', 'quality-judge', '规则校验 + 受限评委，输出五维分与返工建议', 'standard', '["run_rules","blind_review"]', '你是质量评估员，只按 rubric 打分并引用证据，不评价文风。'],
  ['doc', '文档生成 Agent', 'doc-builder', '合并章节、校验编号、导出 Word 并回填元数据', 'fast', '["merge_sections","export_docx"]', '你是文档工程师，负责版式、编号与导出校验。'],
  ['supervisor', 'Supervisor 总控', 'orchestrator', '规划与重规划：决定调用哪些 Agent、是否并行、是否返工', 'strong', '["plan","replan","dispatch"]', '你是工作流总控，只产出计划，不撰写任何标书内容。'],
];

export const FALLBACK_PLAN = {
  plan_version: 1,
  objective: '标准投标全流程：解析 → 检索 → 策略 → 技术/商务 → 合规 → 质量 → 人工审核 → 导出',
  nodes: [
    { node_key: 'parse-tender', agent_key: 'parse-tender', node_type: 'agent', depends_on: [] },
    { node_key: 'knowledge', agent_key: 'knowledge', node_type: 'agent', depends_on: ['parse-tender'] },
    { node_key: 'strategy', agent_key: 'bid-strategy', node_type: 'agent', depends_on: ['parse-tender', 'knowledge'] },
    { node_key: 'quality-1', agent_key: 'quality', node_type: 'quality', depends_on: ['strategy'] },
    { node_key: 'review-1', agent_key: 'supervisor', node_type: 'human-review', depends_on: ['quality-1'], review_policy_key: 'single', gate_policy: 'always-human' },
    { node_key: 'tech', agent_key: 'tech', node_type: 'agent', depends_on: ['review-1'], params: { generate_outline: true, generate_content: true } },
    { node_key: 'commercial', agent_key: 'commercial', node_type: 'agent', depends_on: ['review-1', 'knowledge'] },
    { node_key: 'compliance', agent_key: 'compliance', node_type: 'agent', depends_on: ['tech', 'commercial'] },
    { node_key: 'quality-2', agent_key: 'quality', node_type: 'quality', depends_on: ['compliance', 'tech', 'commercial'] },
    { node_key: 'review-2', agent_key: 'supervisor', node_type: 'human-review', depends_on: ['quality-2'], review_policy_key: 'default', gate_policy: 'always-human' },
    { node_key: 'export', agent_key: 'doc', node_type: 'export', depends_on: ['review-2'] },
  ],
  budget: { max_tokens: 3000000, max_wall_ms: 14400000, max_agent_calls: 40 },
  stop_conditions: ['veto_unresolved', 'budget_exceeded', 'quality_iteration_limit'],
  rationale: 'FallbackPlan：确定性 DAG，保证任何情况下都能完整产出标书。',
};

const envLlm = () => ({
  mode: process.env.LLM_MODE || (process.env.LLM_API_KEY ? 'openai' : 'mock'),
  base_url: process.env.LLM_BASE_URL || '',
  api_key: process.env.LLM_API_KEY || '',
  model: process.env.LLM_MODEL || 'deepseek-v4.1-flash',
  session_id: process.env.LLM_SESSION_ID || 'bidcore',
  temperature: Number(process.env.LLM_TEMPERATURE || 0.3),
});

export const DEFAULT_SETTINGS = {
  llm: { ...envLlm(), timeout_ms: Number(process.env.LLM_TIMEOUT_MS || 90000) },
  quality: {
    weights: { requirement_coverage: 30, accuracy: 25, technical_quality: 20, material_match: 15, documentation: 10 },
    passScore: 80,
    reviseScore: 60,
    maxIterations: 3,
    judge: { enabled: true, two_pass: false, model: process.env.LLM_JUDGE_MODEL || '' },
    thresholds: { duplicateSimilarity: 0.72, minSectionWords: 120, certWarnDays: 45 },
  },
  workflow: { enabled: true, parallelism: 2, leaseSeconds: 45, scanIntervalMs: 1200 },
  review: { allowAutoPass: false, remindRatio: 0.75 },
};

export function seed() {
  const existing = get('SELECT COUNT(*) AS c FROM users');
  if (existing && existing.c > 0) return { seeded: false };

  const now = nowIso();
  const users = tx(() => {
    const rows = [
      ['admin', 'admin123', '王工 · 平台管理员', 'admin', '项目管理中心', '管理员', ['review-center', 'workflow']],
      ['owner', 'owner123', '陈静 · 项目负责人', 'user', '投标管理部', '项目负责人', ['review-center', 'workflow']],
      ['tech', 'tech123', '赵磊 · 技术负责人', 'user', '技术方案部', '技术负责人', ['review-center']],
      ['biz', 'biz123', '孙倩 · 商务负责人', 'user', '商务合约部', '商务负责人', ['review-center']],
      ['reviewer', 'reviewer123', '李审核 · 质量审核员', 'user', '质量管理部', '审核员', ['review-center']],
    ];
    const ids = {};
    for (const [username, password, display, role, department, title, modules] of rows) {
      const r = run(
        'INSERT INTO users (username, password_hash, display_name, role, modules, created_at, department, title) VALUES (?,?,?,?,?,?,?,?)',
        username, hashPassword(password), display, role, jstr(modules), now, department, title,
      );
      ids[username] = Number(r.lastInsertRowid);
    }
    return ids;
  });

  const projects = tx(() => {
    const a = run(
      'INSERT INTO projects (code, name, bidder_name, description, status, owner_id, tender_text, tender_name, created_at, updated_at, deadline, budget, industry, tender_meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      'ZWY-2026-0117', 'XX市政务云平台运维服务项目', '智标科技有限公司',
      '政务云年度运维：7×24 值守、双活切换、等保三级与国产化适配', 'active', users.owner,
      TENDER_TEXT, '政务云运维服务项目招标文件.md', now, now, '2026-12-18 09:30', '480 万元', '政务云',
      jstr({ purchaser: 'XX市大数据管理局', agency: 'XX市政府采购中心', method: '综合评分法', score_total: 100 }),
    );
    const b = run(
      'INSERT INTO projects (code, name, bidder_name, description, status, owner_id, tender_text, tender_name, created_at, updated_at, deadline, budget, industry, tender_meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      'YY-2026-0042', 'XX市智慧医院信息系统运维项目', '智标科技有限公司',
      'HIS/EMR/LIS/PACS 核心系统运维，门诊高峰现场保障', 'active', users.owner,
      TENDER_TEXT_HOSPITAL, '智慧医院运维项目招标文件.md', now, now, '2026-12-28 17:00', '320 万元', '医疗信息化',
      jstr({ purchaser: 'XX市第一人民医院', agency: 'XX省招标有限公司', method: '综合评分法', score_total: 100 }),
    );
    return { cloud: Number(a.lastInsertRowid), hospital: Number(b.lastInsertRowid) };
  });

  tx(() => {
    for (const doc of KNOWLEDGE) {
      run(
        'INSERT INTO knowledge_docs (id, title, folder, category, content, tags, expires_at, created_at, library, file_name, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        id('kdoc'), doc.title, doc.folder, doc.category, doc.content, doc.tags, doc.expires_at ?? null, now,
        doc.library, doc.file_name || '', jstr({ source: 'seed', owner: '智标科技' }),
      );
    }
  });

  tx(() => {
    AGENTS.forEach((a, i) => {
      const [key, name, role, desc, tier, tools, prompt] = a;
      run(
        'INSERT INTO agents (id, name, role, description, model_tier, tools, system_prompt, enabled, sort) VALUES (?,?,?,?,?,?,?,?,?)',
        key, name, role, desc, tier, tools, prompt, 1, i,
      );
    });
  });

  tx(() => {
    run(
      'INSERT INTO workflow_defs (id, key, version, name, description, graph_json, policy_json, active, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id('wfd'), 'default', 1, '标准投标工作流',
      '解析 → 知识检索 → 策略 → 质量门禁 → 人工审核（策略确认）→ 技术/商务并行 → 合规 → 质量 → 三级人工审核 → 导出',
      jstr(FALLBACK_PLAN), jstr({ parallelism: 2, max_budget: FALLBACK_PLAN.budget }), 1, now,
    );
    run(
      'INSERT INTO review_policies (id, key, name, levels_json, timeout_json, created_at) VALUES (?,?,?,?,?,?)',
      id('pol'), 'single', '单级审核（项目负责人）',
      jstr([{ level: 1, role: 'project-owner', sla_minutes: 120, on_timeout: 'remind-only' }]),
      jstr({ remind_ratio: 0.75, repeat_minutes: 30, allow_auto_pass: false }), now,
    );
    run(
      'INSERT INTO review_policies (id, key, name, levels_json, timeout_json, created_at) VALUES (?,?,?,?,?,?)',
      id('pol'), 'default', '三级审核（项目负责人 → 商务负责人 → 管理员）',
      jstr([
        { level: 1, role: 'project-owner', sla_minutes: 240, on_timeout: 'escalate' },
        { level: 2, role: `user:${users.biz}`, sla_minutes: 240, on_timeout: 'escalate' },
        { level: 3, role: 'admin', sla_minutes: 480, on_timeout: 'remind-only' },
      ]),
      jstr({ remind_ratio: 0.75, repeat_minutes: 30, allow_auto_pass: false }), now,
    );
    run(
      'INSERT INTO review_policies (id, key, name, levels_json, timeout_json, created_at) VALUES (?,?,?,?,?,?)',
      id('pol'), 'parallel', '并签审核（技术 + 商务同时签）',
      jstr([
        { level: 1, role: `user:${users.tech}`, sla_minutes: 180, on_timeout: 'remind-only' },
        { level: 1, role: `user:${users.biz}`, sla_minutes: 180, on_timeout: 'remind-only' },
      ]),
      jstr({ remind_ratio: 0.75, repeat_minutes: 30, allow_auto_pass: false, allow_parallel_levels: true }), now,
    );
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      run('INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)', key, jstr(value), now);
    }
    for (const projectId of Object.values(projects)) {
      run('INSERT INTO project_state (project_id, data_json, updated_at) VALUES (?,?,?)', projectId, jstr({ step: 'idle' }), now);
    }
  });

  return { seeded: true, projectId: projects.cloud, projects, users };
}

export function loadSettings() {
  const rows = all('SELECT key, value_json FROM settings');
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const row of rows) {
    try { out[row.key] = { ...(out[row.key] || {}), ...JSON.parse(row.value_json) }; } catch { /* ignore */ }
  }
  return out;
}

