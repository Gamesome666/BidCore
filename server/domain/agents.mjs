// 8 个执行型 Agent 的处理器（supervisor 只出计划，quality 由引擎内联执行）。
// 契约：handler(ctx) → { artifacts:[{kind,summary,payload,provenance}], metrics, log }
import fs from 'node:fs';
import path from 'node:path';
import { all, get } from '../db.mjs';
import { VAR_DIR } from '../db.mjs';
import { clip, sha256 } from '../lib/util.mjs';
import {
  parseTender, matchKnowledge, buildOutline, writeContent,
  buildCommercial, checkCompliance, duplicateReport, buildStrategy,
} from './bid.mjs';
import { writeDocx } from './docx.mjs';

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
  return {
    artifacts: [{
      kind: 'strategy.plan',
      summary: strategy.positioning,
      payload: strategy,
      provenance: { agent: 'bid-strategy' },
    }],
    metrics: { tokens: 900, agent_calls: 0 },
    log: [`评分点 ${strategy.focus.length} 项，差异化亮点 ${strategy.differentiators.length} 条，风险 ${strategy.risks.length} 条`],
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

  const outline = buildOutline(analysis);
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

  const log = [
    `目录：${outline.sections.length} 个一级章节`,
    `正文：${content.total_words} 字（第 ${iteration + 1} 轮）`,
  ];
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
  return {
    artifacts: [{
      kind: 'commercial.pack',
      summary: `资格响应 ${met} 满足 / ${expiring} 临期 / ${missing} 缺失；报价 ${(pack.pricing.total / 10000).toFixed(0)} 万元`,
      payload: pack,
      provenance: { agent: 'commercial' },
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
  const commercial = ctx.artifacts['commercial.pack'];
  const strategy = ctx.artifacts['strategy.plan'];
  const analysis = ctx.artifacts['tender.analysis'];
  if (!content) throw new Error('缺少正文产物，无法导出');

  const title = analysis?.project?.name || ctx.project.name;
  const md = [
    `# ${title}`,
    `投标人：${ctx.project.bidder_name || '我方'}　采购编号：${analysis?.project?.code || '-'}`,
    '',
    '## 投标函摘要',
    `我方已完整阅读招标文件，承诺按 ${analysis?.project?.duration || '12 个月'} 提供服务，投标总报价 ${((commercial?.pricing?.total || 0) / 10000).toFixed(0)} 万元。`,
    '',
    content.markdown,
    '',
    commercial?.markdown || '',
    '',
    '## 投标策略说明（内部留档）',
    strategy?.positioning || '',
    ...(strategy?.differentiators || []).map((d) => `- ${d}`),
  ].join('\n');

  const fileName = `bid-${ctx.run.id.slice(0, 8)}.docx`;
  const filePath = path.join(VAR_DIR, 'files', fileName);
  const { size } = writeDocx(filePath, md, { title, author: ctx.project.bidder_name || 'BidCore', keywords: `run:${ctx.run.id}` });

  return {
    artifacts: [{
      kind: 'doc.docx',
      summary: `Word 已生成：${fileName}（${(size / 1024).toFixed(1)} KB，${content.total_words} 字）`,
      payload: { file: `/files/${fileName}`, size, words: content.total_words, sha256: sha256(md).slice(0, 16) },
      storagePath: filePath,
      provenance: { agent: 'doc', format: 'docx' },
    }],
    metrics: { tokens: 0, agent_calls: 0 },
    log: [`合并章节 ${content.sections.length} 个，商务表格已嵌入`, `导出 ${fileName}（${(size / 1024).toFixed(1)} KB）`],
  };
}

export const AGENT_HANDLERS = {
  'parse-tender': parseTenderAgent,
  knowledge: knowledgeAgent,
  'bid-strategy': strategyAgent,
  tech: techAgent,
  commercial: commercialAgent,
  compliance: complianceAgent,
  doc: docAgent,
};

export function agentMeta(key) {
  return get('SELECT * FROM agents WHERE id = ?', key) || { id: key, name: key, role: key };
}

export function exportMarkdownFile(run, markdown, name) {
  const file = path.join(VAR_DIR, 'files', name);
  fs.writeFileSync(file, markdown, 'utf8');
  return file;
}
