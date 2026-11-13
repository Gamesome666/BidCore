// 8 个执行型 Agent 的处理器（supervisor 只出计划，quality 由引擎内联执行）。
// 契约：handler(ctx) → { artifacts:[{kind,summary,payload,provenance}], metrics, log }
// ctx.agent 由引擎从 agents 表注入（提示词 / 模型档位 / 工具白名单 / 启停），Agent 团队页的配置在这里生效。
import fs from 'node:fs';
import path from 'node:path';
import { all, get, jparse } from '../db.mjs';
import { VAR_DIR } from '../db.mjs';
import { clip, sha256 } from '../lib/util.mjs';
import {
  parseTender, matchKnowledge, buildOutline, buildOutlineFromTender, deriveTechnicalFiles, writeContent, composeContentMarkdown,
  buildCommercial, checkCompliance, duplicateReport, buildStrategy,
} from './bid.mjs';
import { generateText, llmEnabled } from './llm.mjs';
import { extractBidFormat, splitSections, tableRows, longestNumberedRun } from './tenderSections.mjs';
import { writeDocx } from './docx.mjs';
import { buildBidDocument, DEFAULT_BID_ITEMS } from './bidAssembly.mjs';
import { buildQualificationPack } from './qualification.mjs';

/** 所有 Agent 共享的写作底线：不许编造证书号、业绩金额、人员姓名 */
const BASE_STYLE = '你是中文投标文件写作专家。只写招标文件与知识库支持的内容，不编造证书编号、合同金额、人员姓名；'
  + '输出 Markdown 正文，不要重复标题层级，不要解释写作过程，不要出现"待补充"以外的占位内容。';

/**
 * 读取 Agent 运行时配置（Agent 团队页编辑的那份）。
 * 引擎在每个节点执行前调用一次，确保"改了提示词/档位，下一次运行就生效"。
 */
export function agentRuntime(key) {
  const row = get('SELECT * FROM agents WHERE id=?', key);
  if (!row) return { id: key, name: key, role: key, prompt: '', tier: 'standard', tools: [], enabled: true, configured: false };
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    prompt: String(row.system_prompt || ''),
    tier: String(row.model_tier || 'standard'),
    tools: jparse(row.tools, []),
    enabled: Number(row.enabled) === 1,
    configured: true,
  };
}

function agentSystemPrompt(agent, role) {
  const setting = agent.prompt ? `角色设定：${agent.prompt}` : `角色设定：${role || agent.role || agent.name}`;
  return `${BASE_STYLE}\n${setting}`;
}

function agentToolSet(agent) {
  return new Set(Array.isArray(agent?.tools) ? agent.tools : []);
}

/**
 * 用该节点的 Agent 配置写一段正文。
 * mock 模式或模型失败时返回 fallback（模板正文）——保证离线可复现、演示不中断。
 */
async function agentText({ ctx, heading, points = [], numbers = [], refs = [], fallback, role, user: userOverride, maxTokens }) {
  const agent = ctx.agent || {};
  const user = userOverride || [
    `章节：${heading}`,
    points.length ? `需要逐条响应的招标要点：\n${points.slice(0, 6).map((p, i) => `${i + 1}. ${p}`).join('\n')}` : '',
    numbers.length ? `必须出现的量化指标：${numbers.join('、')}` : '',
    refs.length ? `可引用的知识库依据（只能引用这些，不要编造）：${refs.join('、')}` : '',
    '要求：300–500 字，分 2–3 段，落到具体动作、责任人与验收口径，不要空话与套话。',
  ].filter(Boolean).join('\n');
  const text = await generateText({
    system: agentSystemPrompt(agent, role),
    user,
    fallback,
    tier: agent.tier || 'standard',
    maxTokens,
  });
  return { text, usedModel: text !== fallback && !String(text).includes('LLM_FALLBACK') };
}

function listKnowledgeDocs() {
  return all('SELECT id, title, folder, category, content, tags, expires_at FROM knowledge_docs ORDER BY category, title');
}

/** 招标分析 */
export async function parseTenderAgent(ctx) {
  const text = ctx.project.tender_text || '';
  if (!String(text).trim()) throw new Error('项目未上传招标文件');
  const analysis = parseTender(text);
  return {
    artifacts: [{
      kind: 'tender.analysis',
      summary: `解析 ${analysis.stats.requirement_count} 条要求（资格 ${analysis.stats.qualification} / 技术 ${analysis.stats.technical} / 商务 ${analysis.stats.commercial}），评分项 ${analysis.stats.scoring}，废标 ${analysis.stats.veto}`,
      payload: analysis,
      provenance: { agent: 'parse-tender', source: ctx.project.tender_name || 'tender.md' },
    }],
    metrics: { tokens: 1200, agent_calls: 0 },
    log: [
      `读取招标文件「${ctx.project.tender_name || '未命名'}」，共 ${text.length} 字`,
      `识别项目：${analysis.project.name || ctx.project.name} / ${analysis.project.code || '-'}`,
      `抽取要求 ${analysis.stats.requirement_count} 条，评分办法 ${analysis.stats.scoring} 项，废标条款 ${analysis.stats.veto} 条`,
    ],
  };
}

/** 知识检索 */
export async function knowledgeAgent(ctx) {
  const analysis = ctx.artifacts['tender.analysis'];
  if (!analysis) throw new Error('缺少招标解析产物，无法检索');
  const docs = listKnowledgeDocs();
  const pack = matchKnowledge(analysis, docs);
  return {
    artifacts: [{
      kind: 'knowledge.pack',
      summary: `命中 ${pack.hits.length} 条素材，覆盖 ${(pack.coverage * 100).toFixed(0)}%，缺口 ${pack.gaps.length}`,
      payload: { ...pack, docs: docs.map((d) => ({ id: d.id, title: d.title, category: d.category, expires_at: d.expires_at })) },
      provenance: { agent: 'knowledge', search: 'keyword+tag' },
    }],
    metrics: { tokens: 0, agent_calls: 0 },
    log: [
      `检索知识库 ${docs.length} 篇（资质 ${docs.filter((d) => d.category === 'qualification').length} / 案例 ${docs.filter((d) => d.category === 'case').length} / 人员 ${docs.filter((d) => d.category === 'personnel').length}）`,
      `命中 ${pack.hits.length} 条，覆盖 ${(pack.coverage * 100).toFixed(0)}%；缺口 ${pack.gaps.length} 条`,
    ],
  };
}

/** 投标策略 */
export async function strategyAgent(ctx) {
  const analysis = ctx.artifacts['tender.analysis'];
  const knowledge = ctx.artifacts['knowledge.pack'];
  if (!analysis) throw new Error('缺少招标解析产物');
  const strategy = buildStrategy({ analysis, knowledge: knowledge || { hits: [], gaps: [] }, project: ctx.project });

  // Agent 接线：策略定位由该 Agent 的提示词 + 模型档位写，mock 模式沿用模板
  const focusPoints = (strategy.focus || []).slice(0, 5).map((f) => (typeof f === 'string' ? f : f.item || f.name || ''));
  const { text, usedModel } = await agentText({
    ctx,
    heading: '投标策略定位与取舍',
    points: focusPoints,
    numbers: (strategy.differentiators || []).slice(0, 3),
    fallback: strategy.positioning,
    role: '投标策略顾问',
  });
  if (usedModel) {
    strategy.positioning = text;
    strategy.narrative_source = 'llm';
  }

  return {
    artifacts: [{
      kind: 'strategy.plan',
      summary: strategy.positioning,
      payload: strategy,
      provenance: { agent: 'bid-strategy', narrative_source: strategy.narrative_source || 'template' },
    }],
    metrics: { tokens: 900, agent_calls: 0 },
    log: [
      `评分点 ${strategy.focus.length} 项，差异化亮点 ${strategy.differentiators.length} 条，风险 ${strategy.risks.length} 条`,
      `Agent「${ctx.agent?.name || 'bid-strategy'}」档位 ${ctx.agent?.tier || 'standard'}：策略定位${usedModel ? '由模型生成' : '沿用模板（mock 或模型未就绪）'}`,
    ],
  };
}

/** 技术方案：目录 + 正文（带人工反馈应用） */
export async function techAgent(ctx) {
  const analysis = ctx.artifacts['tender.analysis'];
  if (!analysis) throw new Error('缺少招标解析产物，无法生成技术方案');
  const knowledge = ctx.artifacts['knowledge.pack'] || { hits: [], gaps: [] };
  const iteration = Number(ctx.node.iteration || 0);
  const feedback = ctx.feedback;
  const bidder = ctx.project.bidder_name || '我方';

  const formatArtifact = ctx.artifacts['tender.format'] || {};
  const outline = buildOutlineFromTender({ ...analysis, technical_files: deriveTechnicalFiles(analysis, formatArtifact) });
  if (feedback?.edits?.length) {
    for (const edit of feedback.edits) {
      if (edit.path?.includes('outline') && edit.value) {
        outline.sections.push({
          id: `S${outline.sections.length + 1}`, no: `${outline.sections.length + 1}`, level: 1,
          title: String(edit.value).slice(0, 40), target_words: 300, requirement_ids: [], scoring_item: '',
        });
        outline.sections.forEach((s, i) => { s.no = `${i + 1}`; });
        outline.leaf_count = outline.sections.length;
      }
    }
  }

  const content = writeContent({ outline, analysis, knowledge, project: { ...analysis.project, bidder_name: bidder }, iteration, bidder });

  // Agent 接线：真实模型逐章生成（每章按目标字数写满，不足则补写一次）；mock 模式沿用模板
  const tools = agentToolSet(ctx.agent);
  const limit = Math.min(content.sections.length, Math.max(0, Number(process.env.BIDCORE_AGENT_LLM_SECTIONS || content.sections.length)));
  const byReq = new Map(analysis.requirements.map((r) => [r.id, r]));
  const targetOf = new Map(outline.sections.map((s) => [s.title, Number(s.target_words || 800)]));
  let rewritten = 0;
  const modelErrors = [];
  const modelOn = llmEnabled();
  for (const section of content.sections.slice(0, limit)) {
    const reqs = (section.refs?.requirements || []).map((rid) => byReq.get(rid)).filter(Boolean);
    if (!modelOn) continue;
    const target = targetOf.get(section.title) || 800;
    const facts = [
      ctx.project.name && `项目名称：${ctx.project.name}`,
      analysis.project?.owner && `采购人：${analysis.project.owner}`,
      analysis.project?.code && `采购编号：${analysis.project.code}`,
      analysis.project?.duration && `服务期限：${analysis.project.duration}`,
      analysis.project?.budget && `预算/限价：${analysis.project.budget}`,
      `投标人：${bidder}`,
    ].filter(Boolean).join('\n');
    const user = [
      `请撰写投标技术方案中的「${section.title}」一章，目标 ${target} 字（不少于 ${Math.round(target * 0.8)} 字）。`,
      '',
      '项目信息：',
      facts,
      '',
      '对应招标要求（可引用其含义，禁止整段照抄原文）：',
      reqs.length ? reqs.map((r, i) => `${i + 1}. ${clip(r.text, 140)}`).join('\n') : '（本章无直接对应条款，按章节标题写通用方案）',
      '',
      '可用企业材料（仅作证据，不要大段转述）：',
      tools.has('call_knowledge') && (section.refs?.knowledge || []).length ? section.refs.knowledge.join('、') : '无',
      '',
      '写作要求：',
      '1) 分四个小节：需求理解 / 方案设计 / 实施保障 / 承诺指标；',
      '2) 方案设计要写清架构、流程、工具、角色分工，避免空话；',
      '3) 承诺指标必须可核验（响应时长、可用性、人数、频次等数字）；',
      '4) 不要出现「具体包括：1)」这类招标原文罗列，不要写「待补充」；',
      '5) 直接输出正文 Markdown（小标题用 ###），不要解释写作过程。',
    ].join('\n');
    const { text } = await agentText({
      ctx,
      heading: `第 ${section.no} 章 ${section.title}`,
      points: [],
      numbers: [...new Set(reqs.flatMap((r) => r.metrics || []))].slice(0, 4),
      refs: [],
      fallback: section.content,
      role: '技术标主笔',
      user,
      maxTokens: Math.min(4000, Math.round(target * 1.8)),
    });
    let body = String(text || '');
    const fallbackNote = body.match(/<!--\s*LLM_FALLBACK:\s*([\s\S]*?)-->/);
    if (fallbackNote) {
      modelErrors.push(fallbackNote[1].trim().slice(0, 200));
      body = body.replace(/<!--\s*LLM_FALLBACK:[\s\S]*?-->/, '').trim();
    }
    let usedModel = body !== section.content && !body.includes('LLM_FALLBACK');
    // 篇幅不足目标 70%：追加一次补写
    if (usedModel && body.replace(/\s/g, '').length < target * 0.7) {
      const more = await generateText({
        system: `${BASE_STYLE}\n你是技术标主笔，只补写正文，不重复前文。`,
        user: `接着上一节「${section.title}」继续写，补足约 ${Math.max(200, target - body.replace(/\s/g, '').length)} 字，补写「实施保障」「承诺指标」等未展开内容，不要重复前文。只输出正文。`,
        fallback: '',
        tier: 'strong',
        maxTokens: Math.min(3000, Math.round(target * 1.2)),
      });
      if (more && !String(more).includes('LLM_FALLBACK')) body = `${body}\n\n${more}`;
    }
    if (!usedModel) continue;
    section.content = body;
    section.words = String(body).replace(/\s/g, '').length;
    section.narrative_source = 'llm';
    rewritten += 1;
  }
  if (rewritten) {
    content.markdown = composeContentMarkdown({ project: { ...analysis.project, name: ctx.project.name }, bidder, sections: content.sections });
    content.total_words = content.sections.reduce((a, s) => a + s.words, 0);
  }

  const log = [
    `目录：${outline.sections.length} 个一级章节`,
    `正文：${content.total_words} 字（第 ${iteration + 1} 轮）`,
    `Agent「${ctx.agent?.name || 'tech'}」档位 ${ctx.agent?.tier || 'standard'}：模型重写 ${rewritten}/${limit} 章${rewritten ? '' : '（mock 或模型未就绪，沿用模板正文）'}`,
  ];
  if (modelOn && rewritten === 0 && modelErrors.length) {
    log.push(`模型调用失败：${modelErrors[0]}`);
    log.push('请检查「平台设置」里的模型名 / Base URL / API Key（模型名不被服务端接受时，正文会回退模板）');
  }
  content.llm_rewritten = rewritten;
  content.llm_error = modelErrors[0] || null;
  if (feedback?.comment) log.push(`已应用人工意见：${clip(feedback.comment, 60)}`);
  if (iteration === 0) log.push('自检提示：存在 1 处待补充与 1 处篇幅不足，质量门禁将拦截');

  return {
    artifacts: [
      { kind: 'tech.outline', summary: `目录 ${outline.sections.length} 章，覆盖要求 ${outline.covered_requirements.length} 条`, payload: outline, provenance: { agent: 'tech', iteration } },
      { kind: 'tech.content', summary: `正文 ${content.total_words} 字，章节 ${content.sections.length} 个`, payload: content, provenance: { agent: 'tech', iteration, human_edits: feedback?.edits ?? [] } },
    ],
    metrics: { tokens: 4200 + iteration * 200, agent_calls: 1 },
    log,
  };
}

/** 商务标 */
export async function commercialAgent(ctx) {
  const analysis = ctx.artifacts['tender.analysis'];
  const knowledge = ctx.artifacts['knowledge.pack'] || { hits: [] };
  if (!analysis) throw new Error('缺少招标解析产物');
  const pack = buildCommercial({ analysis, knowledge, project: analysis.project, bidder: ctx.project.bidder_name || '我方' });
  const met = pack.qualifications.filter((q) => q.status === 'met').length;
  const expiring = pack.qualifications.filter((q) => q.status === 'expiring').length;
  const missing = pack.qualifications.filter((q) => q.status === 'missing').length;

  // Agent 接线：商务响应总述由该 Agent 写；表格与报价仍走确定性逻辑，避免模型改动数字
  const { text, usedModel } = await agentText({
    ctx,
    heading: '商务响应总述',
    points: pack.qualifications.slice(0, 5).map((q) => `${q.requirement}（${q.certificate || '待补充'}）`),
    numbers: [`报价 ${(pack.pricing.total / 10000).toFixed(0)} 万元`, `资格满足 ${met} 项`],
    fallback: pack.markdown.split('\n').slice(0, 3).join('\n'),
    role: '商务标负责人',
  });
  if (usedModel) {
    pack.markdown = `${text}\n\n${pack.markdown}`;
    pack.narrative_source = 'llm';
  }

  return {
    artifacts: [{
      kind: 'commercial.pack',
      summary: `资格响应 ${met} 满足 / ${expiring} 临期 / ${missing} 缺失；报价 ${(pack.pricing.total / 10000).toFixed(0)} 万元`,
      payload: pack,
      provenance: { agent: 'commercial', narrative_source: pack.narrative_source || 'template' },
    }],
    metrics: { tokens: 800, agent_calls: 0 },
    log: [`资格条件 ${pack.qualifications.length} 项：满足 ${met}，临期 ${expiring}，缺失 ${missing}`, `报价构成 ${pack.pricing.items.length} 项，合计 ${(pack.pricing.total / 10000).toFixed(0)} 万元`],
  };
}

/** 合规审查 + 查重 */
export async function complianceAgent(ctx) {
  const analysis = ctx.artifacts['tender.analysis'];
  if (!analysis) throw new Error('缺少招标解析产物');
  const report = checkCompliance({
    analysis,
    knowledge: ctx.artifacts['knowledge.pack'] || { hits: [] },
    content: ctx.artifacts['tech.content'],
    commercial: ctx.artifacts['commercial.pack'],
  });
  const dup = duplicateReport(ctx.artifacts['tech.content']);
  return {
    artifacts: [
      {
        kind: 'compliance.report',
        summary: `废标条款 ${report.summary.veto_total} 条，未响应 ${report.summary.veto_unresponded}；偏离 ${report.summary.deviation_total} 条，部分满足 ${report.summary.deviation_partial}`,
        payload: report, provenance: { agent: 'compliance' },
      },
      { kind: 'compliance.duplicate', summary: `最高相似度 ${(dup.max_similarity * 100).toFixed(1)}%，重复对 ${dup.pairs.length}`, payload: dup, provenance: { agent: 'compliance' } },
    ],
    metrics: { tokens: 600, agent_calls: 0 },
    log: [
      `废标条款 ${report.summary.veto_total} 条，未响应 ${report.summary.veto_unresponded} 条（风险 ${report.risk_level}）`,
      `响应偏离 ${report.summary.deviation_total} 条，部分满足 ${report.summary.deviation_partial} 条`,
      `查重：最高相似度 ${(dup.max_similarity * 100).toFixed(1)}%，重复对 ${dup.pairs.length} 组`,
    ],
  };
}

/** 文档生成 / 导出 */
export async function docAgent(ctx) {
  const content = ctx.artifacts['tech.content'];
  const commercial = ctx.artifacts['commercial.pack'] || {};
  const analysis = ctx.artifacts['tender.analysis'] || {};
  const format = ctx.artifacts['tender.format'] || {};
  if (!content) throw new Error('缺少正文产物，无法导出');

  // 按第七章 12 项组装整本投标文件：表单类预填、缺项标「待编制」、技术方案作为第 8 项嵌入
  const pack = buildQualificationPack({
    project: ctx.project,
    state: { bid_analysis: analysis, tender_text: ctx.project.tender_text },
    compact: true,
  });
  const assembled = buildBidDocument({
    project: ctx.project,
    analysis,
    format,
    commercial,
    techContent: content,
    pack,
    knowledgeDocs: listKnowledgeDocs(),
  });

  const title = analysis?.project?.name || ctx.project.name;
  const words = assembled.markdown.replace(/\s/g, '').length;

  // 预览模式：终审前先把整本标书正文交给人看，不落 docx（导出节点再生成文件）
  if (ctx.params?.preview) {
    return {
      artifacts: [{
        kind: 'bid.document',
        summary: `标书预览 ${assembled.sections.length} 项 / ${words} 字 / 待编制 ${assembled.gaps.length} 项`,
        payload: { markdown: assembled.markdown, sections: assembled.sections, gaps: assembled.gaps, words },
        provenance: { agent: 'doc', mode: 'preview' },
      }],
      metrics: { tokens: 0, agent_calls: 0 },
      log: [
        `按招标格式组装 ${assembled.sections.length} 项（预览，未落 docx）`,
        assembled.gaps.length ? `待编制 ${assembled.gaps.length} 项：${assembled.gaps.join('、')}` : '全部条目均有内容',
        `正文 ${words} 字，请终审时通读后再放行`,
      ],
    };
  }

  const fileName = `bid-${ctx.run.id.slice(0, 8)}.docx`;
  const filePath = path.join(VAR_DIR, 'files', fileName);
  const { size } = writeDocx(filePath, assembled.markdown, { title, author: ctx.project.bidder_name || 'BidCore', keywords: `run:${ctx.run.id}` });

  return {
    artifacts: [{
      kind: 'doc.docx',
      summary: `投标文件 ${assembled.sections.length} 项（待编制 ${assembled.gaps.length} 项）· ${(size / 1024).toFixed(1)} KB / ${words} 字`,
      payload: {
        file: `/files/${fileName}`, size, words,
        sections: assembled.sections, gaps: assembled.gaps,
        sha256: sha256(assembled.markdown).slice(0, 16),
      },
      storagePath: filePath,
      provenance: { agent: 'doc', format: 'docx', mode: 'bid-assembly' },
    }],
    metrics: { tokens: 0, agent_calls: 0 },
    log: [
      `按招标第七章组装 ${assembled.sections.length} 项：${assembled.sections.slice(0, 4).map((s) => `${s.no} ${s.title}`).join(' / ')}…`,
      assembled.gaps.length ? `待编制 ${assembled.gaps.length} 项：${assembled.gaps.join('、')}` : '全部条目均有内容',
      `导出 ${fileName}（${(size / 1024).toFixed(1)} KB / ${words} 字）`,
    ],
  };
}

/** 编制计划：把“解析结果”落成一份可确认的施工图——结构、章节、取材、缺口、风险 */
const PLAN_CATEGORY = { qualification: '资格', technical: '技术', commercial: '商务', scoring: '评分', veto: '废标' };

export async function planAgent(ctx) {
  const analysis = ctx.artifacts['tender.analysis'] || {};
  const format = ctx.artifacts['tender.format'] || {};
  const knowledge = ctx.artifacts['knowledge.pack'] || { hits: [], gaps: [] };
  const requirements = analysis.requirements || [];
  const flow = [...new Set(requirements.map((r) => r.category))];

  const items = (format.items?.length ? format.items : DEFAULT_BID_ITEMS).map((item, index) => {
    const title = String(item.content || '');
    const pick = (re) => requirements.filter((r) => re.test(r.text));
    let source = '自动生成';
    let reqCount = 0;
    let words = 300;
    let gap = false;
    if (/技术方案/.test(title)) {
      reqCount = pick(/技术|参数|性能|功能|接口|等保|并发|可用性/).length;
      words = 6000;
    } else if (/资格审查/.test(title)) {
      reqCount = requirements.filter((r) => r.category === 'qualification').length;
      source = (knowledge.hits || []).some((h) => /资质|执照|证书/.test(h.title || '')) ? '知识库材料' : '需人工补';
      gap = source === '需人工补';
      words = 800;
    } else if (/业绩/.test(title)) {
      const n = (knowledge.hits || []).filter((h) => /业绩|合同|验收/.test(h.title || '')).length;
      source = n ? `知识库材料（${n} 项）` : '需人工补';
      gap = !n;
      words = 600;
    } else if (/团队|人员/.test(title)) {
      const n = (knowledge.hits || []).filter((h) => /人员|简历|证书/.test(h.title || '')).length;
      source = n ? `知识库材料（${n} 人）` : '需人工补';
      gap = !n;
      words = 500;
    } else if (/报价/.test(title)) {
      source = '按报价构成计算';
      words = 400;
    } else if (/封面|投标函|开标一览表|声明函|承诺/.test(title)) {
      source = '表单预填（项目信息）';
      words = 200;
    } else if (/偏离/.test(title)) {
      reqCount = pick(/★|实质性|参数|商务|资格/).length;
      words = 600;
    }
    return { no: item.no ?? index + 1, title, source, words, requirements: reqCount, gap };
  });

  const outline = buildOutlineFromTender({ ...analysis, technical_files: deriveTechnicalFiles(analysis, ctx.artifacts['tender.format'] || {}) });
  const chapters = outline.sections.map((section) => ({
    no: section.no,
    title: section.title,
    requirements: (section.requirement_ids || []).length,
    words: section.target_words,
  }));

  const missing = items.filter((item) => item.gap).map((item) => `${item.no} ${item.title}`);
  const risks = [];
  if ((analysis.vetoes || []).length) risks.push(`${analysis.vetoes.length} 条废标条款，偏离即无效投标`);
  if (missing.length) risks.push(`${missing.length} 项材料需要人工提供：${missing.join('、')}`);
  if (!format.items?.length) risks.push('未定位到投标文件格式章节，结构按通用 12 项生成');

  const scoring = (analysis.scoring || []).slice(0, 10).map((s, i) => ({
    item: s.item, weight: s.weight, chapter: chapters[Math.min(i, chapters.length - 1)]?.title || '',
  }));

  const markdown = [
    `# 编制计划（${ctx.project.name || analysis.project?.name || ''}）`,
    '',
    `解析出要求 ${requirements.length} 条（${flow.map((c) => `${PLAN_CATEGORY[c] || c} ${requirements.filter((r) => r.category === c).length}`).join(' / ')}），废标条款 ${(analysis.vetoes || []).length} 条。下面是我打算怎么生成这本标书，请确认后再开工。`,
    '',
    '## 一、投标文件结构',
    '',
    '| 序号 | 内容 | 生成方式 | 预计字数 | 覆盖要求 |',
    '| --- | --- | --- | --- | --- |',
    ...items.map((item) => `| ${item.no} | ${item.title} | ${item.source} | ${item.words} | ${item.requirements ? `${item.requirements} 条` : '—'} |`),
    '',
    format.forms?.length ? `必用表单 ${format.forms.length} 个：${format.forms.map((f) => `格式${f.no} ${f.name}`).join('、')}` : '未识别到必用表单。',
    '',
    '## 二、技术方案大纲',
    '',
    '| 章 | 标题 | 要求映射 | 目标字数 |',
    '| --- | --- | --- | --- |',
    ...chapters.map((c) => `| ${c.no} | ${c.title} | ${c.requirements} 条 | ${c.words} |`),
    '',
    '## 三、需要人工补的材料',
    '',
    missing.length ? missing.map((m) => `- ${m}`).join('\n') : '- 无（知识库已覆盖）',
    '',
    '## 四、评分点与章节对应',
    '',
    scoring.length ? scoring.map((s) => `- ${s.item}（${s.weight} 分）→ ${s.chapter}`).join('\n') : '- 未解析到评分办法',
    '',
    '## 五、风险提示',
    '',
    risks.length ? risks.map((r) => `- ${r}`).join('\n') : '- 无',
  ].join('\n');

  return {
    artifacts: [{
      kind: 'bid.plan',
      summary: `编制计划：${items.length} 项结构 / ${chapters.length} 章大纲 / 待补 ${missing.length} 项 / 风险 ${risks.length} 条`,
      payload: {
        markdown,
        document: { items, forms: format.forms || [], sectionTitle: format.sectionTitle || '' },
        technical: { chapters, total_words: chapters.reduce((a, c) => a + c.words, 0) },
        missing,
        scoring,
        risks,
        requirement_count: requirements.length,
      },
      provenance: { agent: 'doc-plan' },
    }],
    metrics: { tokens: 0, agent_calls: 0 },
    log: [
      `结构 ${items.length} 项：${items.slice(0, 4).map((i) => `${i.no} ${i.title}（${i.source}）`).join(' / ')}…`,
      `技术方案 ${chapters.length} 章，规划 ${chapters.reduce((a, c) => a + c.words, 0)} 字`,
      missing.length ? `需人工补 ${missing.length} 项：${missing.join('、')}` : '知识库已覆盖全部材料',
    ],
  };
}

/** 招标格式提取：按标题语义找「投标文件格式」章节，第几章都行；规则找不到时让模型从章节列表里挑 */
export async function formatAgent(ctx) {
  const text = String(ctx.project.tender_text || '');
  const parsed = extractBidFormat(text);
  let { items, forms, sectionTitle } = parsed;
  let source = parsed.source;

  if (!items.length) {
    const picked = await pickFormatSectionWithModel(text).catch(() => null);
    if (picked) {
      items = picked.items;
      sectionTitle = picked.title;
      source = 'llm';
    }
  }

  return {
    artifacts: [{
      kind: 'tender.format',
      summary: `投标文件格式 ${items.length} 项，表单 ${forms.length} 个${sectionTitle ? `（来源：${sectionTitle}）` : ''}`,
      payload: { items, forms, sectionTitle, source, source_name: ctx.project.tender_name || 'tender' },
      provenance: { agent: 'format', locate: source },
    }],
    metrics: { tokens: 0, agent_calls: 0 },
    log: [
      sectionTitle
        ? `定位章节「${sectionTitle}」（${source === 'llm' ? '模型识别' : '标题语义匹配'}），解析到 ${items.length} 项投标文件组成`
        : '未定位到投标文件格式章节，按通用 12 项兜底',
      items.length ? `清单：${items.slice(0, 4).map((i) => i.content).join(' / ')}…` : '',
      forms.length ? `必用表单 ${forms.length} 个：${forms.slice(0, 6).map((f) => `格式${f.no} ${f.name}`).join('、')}` : '未检测到必用表单',
    ].filter(Boolean),
  };
}

/** 规则找不到格式章节时，让模型在章节列表里选一个（mock 模式直接返回空，不影响可复现） */
async function pickFormatSectionWithModel(text) {
  const sections = splitSections(text).filter((section) => section.lines.length).slice(0, 40);
  if (!sections.length) return null;
  const list = sections.map((section, i) => `${i + 1}. ${section.title}`).join('\n');
  const answer = await generateText({
    system: '你是招标文件结构分析助手。只输出一个序号，不要解释。',
    user: `下面是一份招标文件的章节列表，请指出哪一章规定了「投标文件格式 / 投标文件组成」：\n${list}`,
    fallback: '',
    tier: 'fast',
  });
  const index = Number((String(answer).match(/\d+/) || [])[0]);
  const section = sections[index - 1];
  if (!section) return null;
  const items = longestNumberedRun(tableRows(section.lines));
  return items.length ? { title: section.title, items } : null;
}

/** 四类审查共用：按关键词把要求分桶，再用知识库判断有无证明材料 */
const REVIEW_RULES = {
  qualification: { label: '资格', re: /资格|资质|证书|认证|ISO|ITSS|CMMI|营业执照|社保|财务报告/ },
  technical: { label: '技术', re: /技术|参数|性能|功能|接口|并发|等保|可用性|响应|架构|部署/ },
  material: { label: '材料', re: /材料|证明|扫描件|原件|授权|承诺|声明|保函|保证金|盖章|签字/ },
  other: { label: '其他', re: null },
};

function makeReviewAgent(focus) {
  const rule = REVIEW_RULES[focus];
  return async function reviewAgent(ctx) {
    const analysis = ctx.artifacts['tender.analysis'];
    if (!analysis) throw new Error('缺少招标解析产物');
    const docs = listKnowledgeDocs();
    const requirements = analysis.requirements || [];
    const picked = requirements.filter((req) => {
      if (!rule.re) return !Object.values(REVIEW_RULES).some((r) => r.re && r.re.test(req.text)) || focus === 'other';
      return rule.re.test(req.text);
    });
    const corpus = docs.map((d) => `${d.title} ${d.content}`).join('\n');
    const rows = picked.map((req) => {
      const tokens = [...new Set(String(req.text).match(/ISO\s?\d+|ITSS|CMMI|等保\s?[\d.]+|营业执照|信息系统项目管理师|PMP|系统集成|软件设计师/g) || [])]
        .map((t) => t.replace(/\s+/g, ''));
      const matched = tokens.filter((token) => corpus.toUpperCase().includes(token.toUpperCase()));
      const evidence = docs.find((d) => tokens.some((token) => String(d.content).toUpperCase().includes(token.toUpperCase())));
      return {
        id: req.id,
        requirement: clip(req.text, 80),
        veto: Boolean(req.veto),
        tokens,
        matched: matched.length > 0,
        evidence: evidence?.title || '',
      };
    });
    const met = rows.filter((r) => r.matched).length;
    const gaps = rows.filter((r) => !r.matched);
    return {
      artifacts: [{
        kind: `review.${focus}`,
        summary: `${rule.label}类要求 ${picked.length} 条：有证据 ${met}，缺口 ${gaps.length}`,
        payload: { focus, label: rule.label, total: picked.length, met, gaps: gaps.map((g) => ({ id: g.id, requirement: g.requirement })), rows },
        provenance: { agent: `${focus}-review` },
      }],
      metrics: { tokens: 300, agent_calls: 0 },
      log: [
        `${rule.label}类要求 ${picked.length} 条，知识库有证据 ${met} 条，缺口 ${gaps.length} 条`,
        ...gaps.slice(0, 3).map((g) => `缺口：${g.requirement}`),
      ],
    };
  };
}

export const qualificationReviewAgent = makeReviewAgent('qualification');
export const technicalReviewAgent = makeReviewAgent('technical');
export const materialReviewAgent = makeReviewAgent('material');
export const otherReviewAgent = makeReviewAgent('other');

/** 法规与案例：从招标正文提标准/法规引用，再到知识库找对应说明与同类案例 */
export async function legalAgent(ctx) {
  const text = String(ctx.project.tender_text || '');
  const analysis = ctx.artifacts['tender.analysis'] || {};
  const docs = listKnowledgeDocs();
  const tokens = [...new Set((text.match(/等保\s?2\.0|GB\/T\s?\d+(?:\.\d+)?|GB\s?\d+|网络安全法|数据安全法|政府采购法|密码法|CCRC|ITSS|ISO\/IEC\s?27001/gi) || [])
    .map((t) => t.replace(/\s+/g, ' ').trim()))].slice(0, 12);
  const references = tokens.map((token) => {
    const hit = docs.find((d) => `${d.title} ${d.content}`.toUpperCase().includes(token.toUpperCase()));
    return { token, evidence: hit?.title || '', covered: Boolean(hit) };
  });
  const cases = docs
    .filter((d) => /业绩|案例|中标|验收|合同/.test(`${d.title} ${d.category}`))
    .map((d) => ({ title: d.title, category: d.category }));
  const gaps = references.filter((r) => !r.covered);
  return {
    artifacts: [{
      kind: 'legal.pack',
      summary: `法规/标准 ${references.length} 项（已覆盖 ${references.length - gaps.length}），同类案例 ${cases.length} 条`,
      payload: { references, cases, gaps, sources: tokens.length },
      provenance: { agent: 'legal', search: 'keyword' },
    }],
    metrics: { tokens: 400, agent_calls: 0 },
    log: [
      `识别法规/标准引用 ${references.length} 项：${tokens.slice(0, 5).join('、') || '无'}`,
      `知识库覆盖 ${references.length - gaps.length} 项，缺口 ${gaps.length} 项；可引用同类案例 ${cases.length} 条`,
    ],
  };
}

/** 一致性检查：项目名/编号/金额/工期/质保期在正文与需求之间是否自洽 */
export async function consistencyAgent(ctx) {
  const analysis = ctx.artifacts['tender.analysis'] || {};
  const content = ctx.artifacts['tech.content'] || {};
  const commercial = ctx.artifacts['commercial.pack'] || {};
  const text = String(content.markdown || '');
  const meta = analysis.project || {};
  const conflicts = [];
  const checks = [];

  const must = [
    ['项目名称', meta.name],
    ['采购编号', meta.code],
    ['采购人', meta.owner],
  ];
  for (const [label, value] of must) {
    if (!value) continue;
    const ok = text.includes(String(value)) || String(commercial.markdown || '').includes(String(value));
    checks.push({ item: label, value: String(value), ok });
    if (!ok) conflicts.push({ kind: 'missing_fact', detail: `正文未出现${label}：${value}` });
  }

  const durations = [...new Set((text.match(/\d+\s*(?:个?月|日历天)/g) || []).map((v) => v.replace(/\s+/g, '')))];
  if (durations.length > 1) {
    conflicts.push({ kind: 'duration_conflict', detail: `正文出现多种工期口径：${durations.join(' / ')}`, values: durations });
  }
  checks.push({ item: '工期口径', value: durations.join(' / ') || '未出现', ok: durations.length <= 1 });

  const budgets = [...new Set((text.match(/[\d,]+\.\d{2}\s*元/g) || []))].slice(0, 5);
  checks.push({ item: '金额出现', value: budgets.join(' / ') || '无', ok: budgets.length > 0 });

  const placeholders = (text.match(/待补充|TODO|TBD|XXX/g) || []).length;
  if (placeholders) conflicts.push({ kind: 'placeholder', detail: `正文仍有 ${placeholders} 处待补充标记` });

  return {
    artifacts: [{
      kind: 'consistency.report',
      summary: `一致性检查 ${checks.length} 项，冲突 ${conflicts.length} 条`,
      payload: { checks, conflicts, generated_at: new Date().toISOString() },
      provenance: { agent: 'consistency' },
    }],
    metrics: { tokens: 0, agent_calls: 0 },
    log: [
      `检查 ${checks.length} 项：${checks.map((c) => `${c.item}${c.ok ? '✓' : '✗'}`).join('、')}`,
      conflicts.length ? `发现 ${conflicts.length} 条冲突：${conflicts.slice(0, 3).map((c) => c.detail).join('；')}` : '未发现口径冲突',
    ],
  };
}

/** 汇总：把整条流水线的产物压成一份可读摘要（终审和导出前给人看的那页） */
export async function summaryAgent(ctx) {
  const analysis = ctx.artifacts['tender.analysis'] || {};
  const format = ctx.artifacts['tender.format'] || {};
  const legal = ctx.artifacts['legal.pack'] || {};
  const consistency = ctx.artifacts['consistency.report'] || {};
  const content = ctx.artifacts['tech.content'] || {};
  const reviews = ['qualification', 'technical', 'material', 'other']
    .map((focus) => ctx.artifacts[`review.${focus}`])
    .filter(Boolean);
  const gaps = reviews.reduce((sum, r) => sum + (r.gaps?.length || 0), 0);

  const lines = [
    `# 投标文件编制汇总`,
    '',
    `- 招标要求：${(analysis.requirements || []).length} 条（废标 ${(analysis.vetoes || []).length} 条）`,
    `- 投标文件格式：${(format.items || []).length} 项，必用表单 ${(format.forms || []).length} 个`,
    `- 四类审查：${reviews.map((r) => `${r.label}缺口 ${r.gaps?.length || 0}`).join(' / ') || '未执行'}`,
    `- 法规/案例：引用 ${(legal.references || []).length} 项，案例 ${(legal.cases || []).length} 条`,
    `- 技术方案：${content.total_words || 0} 字 / ${(content.sections || []).length} 章`,
    `- 一致性：${(consistency.conflicts || []).length} 条冲突`,
    `- 待补材料合计：${gaps} 项`,
  ];
  return {
    artifacts: [{
      kind: 'summary.pack',
      summary: `汇总：要求 ${(analysis.requirements || []).length} 条 / 格式 ${(format.items || []).length} 项 / 缺口 ${gaps} 项 / 冲突 ${(consistency.conflicts || []).length} 条`,
      payload: { markdown: lines.join('\n'), gaps, conflicts: consistency.conflicts || [] },
      provenance: { agent: 'summary' },
    }],
    metrics: { tokens: 0, agent_calls: 0 },
    log: [`汇总 ${(analysis.requirements || []).length} 条要求、${gaps} 项缺口、${(consistency.conflicts || []).length} 条一致性冲突`],
  };
}

export const AGENT_HANDLERS = {
  'parse-tender': parseTenderAgent,
  knowledge: knowledgeAgent,
  format: formatAgent,
  'doc-plan': planAgent,
  'bid-strategy': strategyAgent,
  tech: techAgent,
  commercial: commercialAgent,
  compliance: complianceAgent,
  doc: docAgent,
  'doc-preview': docAgent,
  legal: legalAgent,
  consistency: consistencyAgent,
  summary: summaryAgent,
  'qualification-review': qualificationReviewAgent,
  'technical-review': technicalReviewAgent,
  'material-review': materialReviewAgent,
  'other-review': otherReviewAgent,
};

export function agentMeta(key) {
  return get('SELECT * FROM agents WHERE id = ?', key) || { id: key, name: key, role: key };
}

export function exportMarkdownFile(run, markdown, name) {
  const file = path.join(VAR_DIR, 'files', name);
  fs.writeFileSync(file, markdown, 'utf8');
  return file;
}
