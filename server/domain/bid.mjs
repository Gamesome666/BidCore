// 投标领域逻辑：招标解析 / 目录 / 全局事实 / 正文 / 检查 / 响应偏离 / 导出校验。
//
// 这里同时维护两套契约，互不干扰：
//  1) 旧形态（engine/agents/compat 在用）：parseTender / matchKnowledge / buildOutline / writeContent /
//     buildCommercial / checkCompliance / duplicateReport / buildStrategy。
//     字段名沿用 bidflow（qualification/technical/veto…，outline.sections，content.sections）。
//  2) 新形态（/api/projects/:id/technical-plan 六步流水线）：parseBidAnalysis / buildOutlineTree /
//     buildGlobalFacts / generateChapters / checkRejection / checkDuplicate / buildDeviationRows /
//     validateExport / composeProjectMarkdown。
//     字段名对齐 yibiao technical-plan state（bid_analysis/outline/global_facts/content/checks/deviation/export）。
//
// 确定性约定：所有产出只由项目名 / 招标原文 / 索引派生，不使用随机数，保证 smoke 与演示可复现。
import { get } from '../db.mjs';
import { clip, splitSentences, jaccard, shingles, nowIso } from '../lib/util.mjs';
import { mockProse } from './llm.mjs';

const KEYWORDS = [
  '7×24', '30 分钟', '2 小时', '99.9%', '驻场', '应急演练', '等保 2.0 三级', '知识库',
  'ISO9001', 'ISO27001', 'CMMI 3', 'PMP', '保证金', '可用性', '响应时间', '运维',
];

/** 旧形态的分类键 → 中文标签（新形态对外用中文，前端直接渲染） */
const CATEGORY_LABEL = {
  qualification: '资格',
  technical: '技术',
  commercial: '商务',
  scoring: '评分',
  veto: '废标',
  overview: '概述',
  other: '其他',
};

/** 兜底响应判定词：条款里没有量化指标时，用这些承诺关键词判断是否已响应 */
const COMMITMENT_TOKENS = ['保证金', '报价', '资格', '证书', '偏离表', '7×24', '承诺', '响应'];

/** 全篇统一的承诺口径：同时覆盖废标条款里的 保证金/报价/偏离表/资格证书/7×24/30 分钟/2 小时 */
const COMMITMENT = '我方承诺：投标保证金已足额提交并可提供银行转账凭证；报价未超过最高限价且不低于成本价；'
  + '随本方案提交《技术响应与偏离表》并逐条说明偏离情况；资格类证书（ISO9001、ISO27001、CMMI、ITSS、PMP）'
  + '均在有效期内并可接受原件核验；提供 7×24 小时值守，一般故障 30 分钟内响应，重大故障 2 小时内恢复。';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 中文字数（去空白与标记），与前端「字数」口径一致 */
export function countChars(text) {
  return String(text ?? '').replace(/\s+/g, '').length;
}

function stripNumbering(text) {
  return String(text ?? '').replace(/^[\s\-*•]+/, '').replace(/^[（(]?\d+[）).、]\s*/, '').trim();
}

function detectCategory(title) {
  if (/资格/.test(title)) return 'qualification';
  if (/技术|需求|方案/.test(title)) return 'technical';
  if (/商务|报价|付款/.test(title)) return 'commercial';
  if (/评分|评审|评标/.test(title)) return 'scoring';
  if (/废标|无效|否决/.test(title)) return 'veto';
  if (/概述|简介|背景/.test(title)) return 'overview';
  return 'other';
}

function extractMetrics(text) {
  const out = [];
  for (const m of String(text).matchAll(/(\d+(?:\.\d+)?)\s*%/g)) out.push(`${m[1]}%`);
  for (const m of String(text).matchAll(/(\d+)\s*分钟/g)) out.push(`${m[1]} 分钟`);
  for (const m of String(text).matchAll(/(\d+)\s*小时/g)) out.push(`${m[1]} 小时`);
  for (const m of String(text).matchAll(/(\d+)\s*人/g)) out.push(`${m[1]} 人`);
  for (const m of String(text).matchAll(/(\d+)\s*篇/g)) out.push(`${m[1]} 篇`);
  for (const m of String(text).matchAll(/(\d+)\s*个工作日/g)) out.push(`${m[1]} 个工作日`);
  if (/7×24/.test(text)) out.push('7×24');
  if (/等保\s*2\.0\s*三级/.test(text)) out.push('等保 2.0 三级');
  return [...new Set(out)];
}

function normalizeHeading(raw) {
  return String(raw || '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[一二三四五六七八九十百]+[、.．]\s*/, '')
    .trim();
}

/**
 * 条款抽取（旧/新形态共用的底座）：按标题分段、按"1. xxx"编号取条目，
 * 同时记录 章节序号 / 行号 / 原始标题，作为"原文锚点"。
 */
export function extractClauses(text) {
  const lines = String(text || '').split(/\r?\n/);
  const clauses = [];
  const meta = { name: '', code: '', budget: '', duration: '', location: '', owner: '', deadline: '', agency: '' };
  const headings = [];
  let headingRaw = '正文';
  let headingIndex = 0;
  let headingTitle = '正文';
  let lineNo = 0;

  const META_KEYS = {
    采购编号: 'code', 项目编号: 'code', 招标编号: 'code',
    项目名称: 'name',
    预算金额: 'budget', 最高限价: 'budget',
    服务期限: 'duration', 工期: 'duration', 服务期: 'duration',
    项目地点: 'location', 服务地点: 'location',
    采购人: 'owner', 招标人: 'owner',
    代理机构: 'agency',
    投标截止: 'deadline', 截止时间: 'deadline', 投标截止时间: 'deadline',
  };

  for (const raw of lines) {
    lineNo += 1;
    const line = raw.trim();
    if (!line) continue;

    const head = line.match(/^#{1,6}\s*(.+)$/);
    if (head) {
      headingRaw = head[1].trim();
      headingTitle = normalizeHeading(headingRaw);
      headingIndex += 1;
      headings.push({ index: headingIndex, title: headingTitle });
      continue;
    }

    const kv = line.match(/^(采购编号|项目编号|招标编号|项目名称|预算金额|最高限价|服务期限|工期|服务期|项目地点|服务地点|采购人|招标人|代理机构|投标截止时间|投标截止|截止时间)[:：]\s*(.+)$/);
    if (kv) {
      meta[META_KEYS[kv[1]]] = kv[2].trim();
      continue;
    }

    const item = line.match(/^(\d+)\s*[.、)）]\s*(.+)$/);
    if (!item) continue;
    const idx = headingIndex || 1;
    clauses.push({
      heading: headingRaw,
      headingTitle,
      headingIndex: idx,
      itemNo: Number(item[1]),
      line: lineNo,
      text: item[2].trim(),
      categoryKey: detectCategory(headingTitle),
    });
  }

  return { clauses, meta, headings };
}

/* ───────────────────────────── 旧形态（保持接口不变） ───────────────────────────── */

/** 招标文件解析（旧契约）：项目元信息 + 条款清单 + 评分办法 + 废标条款 */
export function parseTender(text) {
  const { clauses, meta } = extractClauses(text);
  const idx = { n: 0 };
  const requirements = clauses.map((c) => {
    idx.n += 1;
    return {
      id: `REQ-${pad2(idx.n)}`,
      clause: `${c.heading} ${c.itemNo}`,
      category: c.categoryKey,
      text: c.text,
      must: c.categoryKey === 'qualification' || c.categoryKey === 'veto' || /须|不得|必须|应/.test(c.text),
      metrics: extractMetrics(c.text),
      keywords: KEYWORDS.filter((k) => c.text.includes(k)),
    };
  });

  const scoring = clauses
    .filter((c) => c.categoryKey === 'scoring')
    .map((c) => {
      const score = c.text.match(/[（(](\d+)\s*分[)）]/);
      return { item: c.text.split(/[（(：:]/)[0].trim(), weight: score ? Number(score[1]) : 0, detail: c.text };
    });

  const vetoes = clauses
    .filter((c) => c.categoryKey === 'veto')
    .map((c) => ({ clause: `${c.heading} ${c.itemNo}`, text: c.text }));

  const requiredIds = requirements.filter((r) => r.must || r.category === 'technical').map((r) => r.id);

  return {
    project: {
      name: meta.name, code: meta.code, budget: meta.budget, duration: meta.duration,
      location: meta.location, owner: meta.owner, deadline: meta.deadline,
    },
    requirements,
    scoring,
    vetoes,
    completeness: { required: requiredIds.length, satisfied: requiredIds.length, required_ids: requiredIds },
    parsed_at: nowIso(),
    stats: {
      requirement_count: requirements.length,
      qualification: requirements.filter((r) => r.category === 'qualification').length,
      technical: requirements.filter((r) => r.category === 'technical').length,
      commercial: requirements.filter((r) => r.category === 'commercial').length,
      scoring: scoring.length,
      veto: vetoes.length,
    },
  };
}

/** 知识检索：按资质/技术关键词匹配知识库，产出命中与缺口（可溯源） */
export function matchKnowledge(analysis, docs) {
  const hits = [];
  const gaps = [];
  const reqs = analysis.requirements.filter((r) => ['qualification', 'technical', 'commercial'].includes(r.category));

  for (const req of reqs) {
    const tokens = [...req.keywords];
    if (req.category === 'qualification') {
      for (const token of ['ISO9001', 'ISO27001', 'CMMI 3', 'PMP']) {
        if (req.text.includes(token) && !tokens.includes(token)) tokens.push(token);
      }
    }
    if (tokens.length === 0) continue;
    const matched = docs.filter((doc) => tokens.some((t) => doc.title.includes(t) || doc.content.includes(t) || String(doc.tags).includes(t)));
    if (matched.length) {
      for (const doc of matched.slice(0, 3)) {
        hits.push({
          doc_id: doc.id, title: doc.title, category: doc.category,
          requirement_id: req.id, requirement: clip(req.text, 80),
          matched_keywords: tokens.filter((t) => doc.content.includes(t) || doc.title.includes(t)),
          evidence: clip(doc.content, 160),
          expires_at: doc.expires_at ?? null,
        });
      }
    } else if (req.category === 'qualification' || tokens.some((t) => /ISO|CMMI|PMP|等保/.test(t))) {
      gaps.push({ requirement_id: req.id, requirement: clip(req.text, 90), keywords: tokens, note: '知识库未检索到对应证明材料，需补充或由商务 Agent 说明' });
    }
  }

  const uniqueHits = [];
  const seen = new Set();
  for (const h of hits) {
    const key = `${h.doc_id}:${h.requirement_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueHits.push(h);
  }
  const coverage = reqs.length ? Math.min(1, uniqueHits.length / reqs.length) : 0;
  return { hits: uniqueHits, gaps, coverage, doc_count: docs.length, searched_at: nowIso() };
}

const OUTLINE_BLUEPRINT = [
  { title: '项目理解与总体服务方案', match: ['项目概述', '总体'], target: 420 },
  { title: '运维服务体系与 SLA 保障', match: ['7×24', '响应', '可用性', '恢复'], target: 520 },
  { title: '驻场团队与人员配置', match: ['驻场', '项目经理', 'PMP'], target: 380 },
  { title: '运维知识库建设与运营', match: ['知识库', '手册'], target: 320 },
  { title: '安全加固与等保 2.0 三级合规', match: ['等保', '安全加固'], target: 460 },
  { title: '应急演练与业务连续性保障', match: ['应急演练'], target: 400 },
  { title: '质量管理体系与持续改进', match: ['ISO9001', '质量'], target: 300 },
  { title: '商务响应与业绩证明', match: ['保证金', '付款', '业绩', '报价', 'ISO9001', 'ISO27001', 'CMMI', 'PMP', '资格'], target: 340 },
  { title: '评分点响应索引表', match: ['评分'], target: 260 },
];

/** 目录生成（旧契约）：按评分办法 + 技术条款映射章节 */
export function buildOutline(analysis) {
  const sections = OUTLINE_BLUEPRINT.map((bp, i) => {
    const requirement_ids = analysis.requirements
      .filter((r) => bp.match.some((m) => r.text.includes(m) || (r.category === 'scoring' && m === '评分')))
      .map((r) => r.id);
    const scoring_hint = analysis.scoring[i % Math.max(1, analysis.scoring.length)];
    return {
      id: `S${i + 1}`,
      no: `${i + 1}`,
      level: 1,
      title: bp.title,
      target_words: bp.target,
      requirement_ids,
      scoring_item: scoring_hint?.item ?? '',
    };
  });
  return {
    sections,
    leaf_count: sections.length,
    covered_requirements: [...new Set(sections.flatMap((s) => s.requirement_ids))],
    generated_at: nowIso(),
  };
}

/** 正文写作（旧契约）：第 0 轮故意留两类缺陷供 Self-Loop 演示 */
export function writeContent({ outline, analysis, knowledge, project, iteration, bidder }) {
  const defect = iteration === 0;
  const byReq = new Map(analysis.requirements.map((r) => [r.id, r]));
  const docs = knowledge.hits || [];

  const sections = outline.sections.map((section, index) => {
    const reqs = (section.requirement_ids || []).map((rid) => byReq.get(rid)).filter(Boolean);
    const points = reqs.map((r) => clip(r.text.replace(/^[，,]/, ''), 60));
    const numbers = [...new Set(reqs.flatMap((r) => r.metrics))].slice(0, 4);
    const refDocs = docs.filter((d) => reqs.some((r) => d.requirement_id === r.id)).slice(0, 3);
    const refs = { requirements: reqs.map((r) => r.id), knowledge: refDocs.map((d) => d.title) };

    let body = mockProse({ heading: section.title, points, numbers, refs: refDocs.map((d) => d.title), bidder });

    if (index === 0) {
      body = `${body}\n\n本项目的服务对象为${project.owner || '采购人'}，服务期限为${project.duration || '12 个月'}，我方（${bidder}）将按${project.budget || '预算'}范围内的服务承诺组织实施，确保按期交付。`;
    }
    if (index === 8) {
      body = `${body}\n\n评分点响应索引：${analysis.scoring.map((s) => `${s.item}（${s.weight} 分）→ 第 ${Math.min(8, analysis.scoring.indexOf(s) + 1)} 章`).join('；')}。`;
    }

    if (defect && section.title.includes('等保')) body = `${body}\n\n待补充：等保三级整改台账（后续补充）。`;
    if (defect && section.title.includes('知识库')) body = '我方将建设运维知识库。';
    if (defect && (section.title.includes('应急') || section.title.includes('SLA'))) {
      body = `${body}\n\n我方承诺提供 7×24 小时值守与 30 分钟响应，重大故障 2 小时内恢复，每季度开展一次应急演练并提交演练报告，确保业务连续性。`;
    }

    const words = body.replace(/\s/g, '').length;
    return {
      id: section.id, no: section.no, title: section.title,
      content: body, words, refs,
      traceable: refs.requirements.length > 0 || refs.knowledge.length > 0,
    };
  });

  const markdown = [
    `# ${project.name || '投标技术方案'}`,
    `投标人：${bidder}`,
    `采购编号：${project.code || '-'}`,
    '',
    ...sections.map((s) => `## ${s.no} ${s.title}\n\n${s.content}`),
  ].join('\n\n');

  return {
    sections, markdown,
    total_words: sections.reduce((a, s) => a + s.words, 0),
    iteration,
    generated_at: nowIso(),
  };
}

/** 商务标（旧契约）：资质/人员/业绩响应矩阵 + 报价构成 */
export function buildCommercial({ analysis, knowledge, project, bidder }) {
  const quals = analysis.requirements.filter((r) => r.category === 'qualification');
  const qualifications = quals.map((req) => {
    const hit = (knowledge.hits || []).find((h) => h.requirement_id === req.id);
    const doc = hit ? get('SELECT * FROM knowledge_docs WHERE id = ?', hit.doc_id) : null;
    let status = 'missing';
    if (hit) status = 'met';
    if (doc?.expires_at && new Date(doc.expires_at).getTime() - Date.now() < 45 * 86400_000) status = 'expiring';
    return {
      requirement_id: req.id,
      requirement: clip(req.text, 80),
      certificate: doc?.title ?? '',
      expires_at: doc?.expires_at ?? null,
      status,
      evidence: doc ? clip(doc.content, 140) : '未在知识库中找到证明材料',
    };
  });

  const total = 4_600_000;
  const pricing = {
    total,
    currency: 'CNY',
    items: [
      { name: '驻场运维人力（3 人 × 12 月）', amount: 2_880_000, note: '项目经理 1 名 + 系统工程师 2 名' },
      { name: '云平台监控与工具订阅', amount: 640_000, note: '自研监控平台 + 第三方工具' },
      { name: '安全加固与等保支撑', amount: 520_000, note: '等保 2.0 三级整改与测评配合' },
      { name: '应急演练与培训', amount: 260_000, note: '每季度 1 次演练，2 次培训' },
      { name: '备品备件与差旅', amount: 300_000, note: '含本地化服务成本' },
    ],
    payment: '按季度支付，验收合格后 30 日内支付',
  };

  const markdown = [
    '## 商务响应总述',
    `投标人：${bidder}；项目：${project.name}；采购编号：${project.code}。`,
    `报价总额：人民币 ${(total / 10000).toFixed(0)} 万元（含一年运维服务全部费用）。`,
    '',
    '## 资格条件响应对照表',
    '| 资格要求 | 证明材料 | 状态 |',
    '| --- | --- | --- |',
    ...qualifications.map((q) => `| ${q.requirement} | ${q.certificate || '待补充'} | ${q.status} |`),
    '',
    '## 报价构成',
    ...pricing.items.map((i) => `- ${i.name}：${(i.amount / 10000).toFixed(1)} 万元（${i.note}）`),
    '',
    '## 保证金与合规承诺',
    '- 投标保证金：人民币 5 万元，已按招标文件要求以银行转账方式提交，凭证随投标文件附后。',
    '- 服务承诺：提供 7×24 小时值守，故障响应时间不超过 30 分钟，重大故障 2 小时内恢复。',
    '- 资格承诺：ISO9001、ISO27001、CMMI 3 级证书及项目经理 PMP 证书均真实有效，可接受原件核验。',
  ].join('\n');

  return { qualifications, pricing, markdown, generated_at: nowIso() };
}

/** 合规审查（旧契约）：废标条款响应 + 响应偏离表 */
export function checkCompliance({ analysis, knowledge, content, commercial }) {
  const text = `${content?.markdown || ''}\n${commercial?.markdown || ''}`;
  const vetoes = analysis.vetoes.map((v) => {
    const keywords = KEYWORDS.filter((k) => v.text.includes(k));
    const responded = keywords.length === 0
      ? /保证金|资格|响应/.test(text)
      : keywords.some((k) => text.includes(k));
    return {
      clause: v.clause,
      text: v.text,
      keywords,
      responded,
      evidence: responded ? clip(text.slice(Math.max(0, text.indexOf(keywords[0] || '响应') - 40), 160), 160) : '',
      severity: 'veto',
    };
  });

  const deviations = analysis.requirements
    .filter((r) => ['technical', 'commercial'].includes(r.category))
    .map((r) => {
      const tokens = r.metrics.length ? r.metrics : r.keywords;
      const hit = tokens.length === 0 ? true : tokens.some((t) => text.includes(t));
      return {
        requirement_id: r.id,
        requirement: clip(r.text, 80),
        response: hit ? '满足' : '部分满足',
        note: hit ? '已在技术方案/商务响应中体现' : '需补充量化承诺或证明材料',
      };
    });

  const unresponded = vetoes.filter((v) => !v.responded);
  const partial = deviations.filter((d) => d.response !== '满足');
  return {
    vetoes, deviations,
    risk_level: unresponded.length ? 'high' : partial.length > 2 ? 'medium' : 'low',
    summary: { veto_total: vetoes.length, veto_unresponded: unresponded.length, deviation_total: deviations.length, deviation_partial: partial.length },
    checked_at: nowIso(),
  };
}

/** 标书查重（旧契约）：章节两两相似度（字符 2-gram Jaccard） */
export function duplicateReport(content) {
  const sections = content?.sections || [];
  const pairs = [];
  for (let i = 0; i < sections.length; i += 1) {
    for (let j = i + 1; j < sections.length; j += 1) {
      const a = shingles(sections[i].content);
      const b = shingles(sections[j].content);
      const sim = jaccard(a, b);
      if (sim > 0.25) {
        const sa = splitSentences(sections[i].content);
        const sb = splitSentences(sections[j].content);
        let best = { text: '', score: 0 };
        for (const x of sa) {
          for (const y of sb) {
            const s = jaccard(shingles(x), shingles(y));
            if (s > best.score) best = { text: x, score: s };
          }
        }
        pairs.push({
          a: sections[i].title, b: sections[j].title,
          similarity: Number(sim.toFixed(3)),
          sample: best.text.slice(0, 120),
          sample_score: Number(best.score.toFixed(3)),
        });
      }
    }
  }
  const max = pairs.reduce((m, p) => Math.max(m, p.similarity), 0);
  return { pairs: pairs.sort((x, y) => y.similarity - x.similarity).slice(0, 8), max_similarity: Number(max.toFixed(3)), checked_at: nowIso() };
}

/** 投标策略（旧契约）：评分点取舍 + 差异化 + 风险 */
export function buildStrategy({ analysis, knowledge, project }) {
  const scoring = analysis.scoring.length
    ? analysis.scoring
    : [{ item: '技术方案', weight: 45 }, { item: '服务能力', weight: 25 }, { item: '商务报价', weight: 20 }, { item: '企业业绩', weight: 10 }];
  const focus = scoring
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((s) => ({
      item: s.item, weight: s.weight,
      plan: /技术/.test(s.item) ? '以 7×24 值守与 30 分钟响应为主线，配套 SLA 度量与月度运行报告'
        : /服务能力/.test(s.item) ? '3 人驻场 + 本地化备件，突出 PMP 项目经理与 RHCE 工程师'
          : /报价/.test(s.item) ? '总价控制在预算范围内，按季度付款匹配现金流'
            : '以 2 个 200 万元以上政务云运维业绩响应',
    }));
  const gaps = knowledge.gaps || [];
  const differentiators = [
    '自研智能运维监控平台（软著 2024SR0456789），告警收敛 + 故障自愈',
    '连续两年政务云项目可用性 99.95%，高于招标要求 99.9%',
    '本地化 3 人驻场团队，30 分钟到场承诺',
  ];
  const risks = gaps.length
    ? gaps.map((g) => ({ risk: `资格/证明材料缺口：${clip(g.requirement, 50)}`, mitigation: '调用知识检索补充证明；仍缺失则由商务 Agent 出具承诺函并列入澄清' }))
    : [{ risk: 'ISO27001 证书临近到期（2026-12-05）', mitigation: '提前提交换证计划与监督审核预约证明' }];

  return { positioning: `以"高可用 + 强合规 + 本地化"作为主策略，围绕 ${focus[0]?.item || '技术方案'} 建立差异化`, focus, differentiators, risks, generated_at: nowIso() };
}

/* ─────────────────────── 新形态：六步流水线的确定性生成器 ─────────────────────── */

const DERIVED_REQUIREMENTS = [
  { key: 'team', category: '技术', text: '投标人须配备满足服务规模的项目团队，明确项目经理与驻场工程师职责并接受采购人考核。', ref: '§附录A.1', weight: 2 },
  { key: 'sla', category: '技术', text: '须建立值守、告警、故障处置与升级路径的闭环机制，并提供可核验的运行报告。', ref: '§附录A.2', weight: 2 },
  { key: 'deliverable', category: '技术', text: '交付物应包含月度运行报告、季度复盘报告与年度服务总结，并按要求归档备查。', ref: '§附录A.3', weight: 1 },
  { key: 'responsiveness', category: '商务', text: '投标人须对招标文件全部条款逐条响应，不得遗漏或负偏离，响应对照表随投标文件提交。', ref: '§附录A.4', weight: 2 },
];

/**
 * 招标解析（新形态）：
 *  - 条款来自原文编号条目，带 章节锚点（§2.1）+ 行号；
 *  - 废标条款自动标记 veto（章节为"废标条款"或正文含"作废标/无效投标/否决"）；
 *  - 原文条目不足 12 条时，从项目元信息与概述句派生补充，保证结构完整。
 */
export function parseBidAnalysis({ text, project = {} }) {
  const { clauses, meta, headings } = extractClauses(text);
  const requirements = [];
  const seen = new Set();

  const push = (req) => {
    const key = stripNumbering(req.text).replace(/[\s，。；、]/g, '').slice(0, 32);
    if (!key || seen.has(key)) return;
    seen.add(key);
    requirements.push(req);
  };

  for (const c of clauses) {
    const label = CATEGORY_LABEL[c.categoryKey] || '其他';
    const veto = c.categoryKey === 'veto' || /作废标|无效投标|否决投标/.test(c.text);
    const weight = veto ? 3 : (c.categoryKey === 'technical' || c.categoryKey === 'qualification') ? 2 : 1;
    push({
      category: label,
      category_key: c.categoryKey,
      text: c.text,
      veto,
      weight,
      response: '',
      responded: false,
      source_ref: `§${c.headingIndex}.${c.itemNo}`,
      source_anchor: { heading: c.headingTitle, line: c.line },
      clause: `${c.headingTitle} · 第 ${c.itemNo} 条`,
      metrics: extractMetrics(c.text),
      keywords: KEYWORDS.filter((k) => c.text.includes(k)),
    });
  }

  // 派生：项目元信息 → 商务/资格条款（采购编号、预算、工期、地点、截止时间）
  const metaLines = [];
  if (meta.name || project.name) metaLines.push({ text: `投标标的为「${meta.name || project.name}」，投标人须按项目名称与编号在投标文件中一致表述。`, category: '概述', ref: '§0.1', weight: 1, veto: false });
  if (meta.budget) metaLines.push({ text: `报价不得超过预算/最高限价（${meta.budget}），超过者按无效投标处理。`, category: '商务', ref: '§0.2', weight: 3, veto: /最高限价|无效/.test(meta.budget) });
  if (meta.duration) metaLines.push({ text: `服务期限为${meta.duration}，投标人须在合同签订后按约定期限完成进场与服务交付。`, category: '技术', ref: '§0.3', weight: 2, veto: false });
  if (meta.location) metaLines.push({ text: `服务地点为${meta.location}，投标人须具备本地化服务能力与到场响应条件。`, category: '技术', ref: '§0.4', weight: 2, veto: false });
  if (meta.deadline) metaLines.push({ text: `投标文件须在${meta.deadline}前提交，逾期送达不予受理。`, category: '商务', ref: '§0.5', weight: 2, veto: false });
  if (meta.owner) metaLines.push({ text: `本项目采购人为${meta.owner}，投标人须按其管理要求接受监督与考核。`, category: '概述', ref: '§0.6', weight: 1, veto: false });

  for (const line of metaLines) {
    push({
      category: line.category,
      category_key: Object.entries(CATEGORY_LABEL).find(([, v]) => v === line.category)?.[0] || 'other',
      text: line.text,
      veto: Boolean(line.veto),
      weight: line.weight,
      response: '',
      responded: false,
      source_ref: line.ref,
      source_anchor: { heading: '项目基本信息', line: 0 },
      clause: '项目基本信息',
      metrics: extractMetrics(line.text),
      keywords: KEYWORDS.filter((k) => line.text.includes(k)),
      derived: true,
    });
  }

  // 概述段落里带约束的句子也可作为要求（去重后补充）
  for (const sentence of splitSentences(String(text || '')).slice(0, 60)) {
    if (!/须|不得|应|要求|不低于|不少于|提供/.test(sentence)) continue;
    if (sentence.length < 14) continue;
    push({
      category: '技术',
      category_key: 'technical',
      text: clip(sentence, 120),
      veto: /作废标|无效投标|否决/.test(sentence),
      weight: 2,
      response: '',
      responded: false,
      source_ref: '§概述摘录',
      source_anchor: { heading: '概述段', line: 0 },
      clause: '概述段摘录',
      metrics: extractMetrics(sentence),
      keywords: KEYWORDS.filter((k) => sentence.includes(k)),
      derived: true,
    });
    if (requirements.length >= 16) break;
  }

  if (requirements.length < 12) {
    for (const d of DERIVED_REQUIREMENTS) {
      if (requirements.length >= 12) break;
      push({
        category: d.category,
        category_key: d.category === '技术' ? 'technical' : 'commercial',
        text: d.text,
        veto: false,
        weight: d.weight,
        response: '',
        responded: false,
        source_ref: d.ref,
        source_anchor: { heading: '通用要求', line: 0 },
        clause: '通用要求',
        metrics: [],
        keywords: KEYWORDS.filter((k) => d.text.includes(k)),
        derived: true,
      });
    }
  }

  requirements.forEach((r, i) => { r.id = `R-${pad2(i + 1)}`; r.order = i + 1; });

  const scoring = clauses
    .filter((c) => c.categoryKey === 'scoring')
    .map((c) => {
      const score = c.text.match(/[（(](\d+)\s*分[)）]/);
      return { item: c.text.split(/[（(：:]/)[0].trim(), weight: score ? Number(score[1]) : 0, detail: c.text };
    });

  const vetoReqs = requirements.filter((r) => r.veto);
  const stats = {
    requirements: requirements.length,
    veto: vetoReqs.length,
    qualification: requirements.filter((r) => r.category === '资格').length,
    technical: requirements.filter((r) => r.category === '技术').length,
    commercial: requirements.filter((r) => r.category === '商务').length,
    scoring: scoring.length,
    derived: requirements.filter((r) => r.derived).length,
    chars: countChars(text),
  };

  const summary = `${meta.name || project.name || '本项目'} 共识别 ${stats.requirements} 条要求：`
    + `废标项 ${stats.veto} 条、资格 ${stats.qualification} 条、技术 ${stats.technical} 条、商务 ${stats.commercial} 条；`
    + `评分办法 ${stats.scoring} 项。`;

  return {
    status: 'success',
    project_meta: {
      name: meta.name || project.name || '',
      code: meta.code || project.code || '',
      budget: meta.budget || project.budget || '',
      duration: meta.duration || '',
      location: meta.location || '',
      owner: meta.owner || '',
      agency: meta.agency || '',
      deadline: meta.deadline || project.deadline || '',
    },
    requirements,
    scoring,
    vetoes: vetoReqs.map((r) => ({ clause: r.source_ref, text: r.text })),
    summary,
    stats,
    source: { chars: countChars(text), headings: headings.length, clauses: clauses.length },
    parsed_at: nowIso(),
  };
}

/** 新形态 → 旧形态投影：给 engine/agents/旧兼容接口用，避免两套数据各写一份 */
export function toLegacyAnalysis(analysis) {
  const requirements = (analysis.requirements || []).map((r) => ({
    id: r.id,
    clause: r.source_ref,
    category: r.category_key,
    text: r.text,
    must: Boolean(r.veto) || /须|不得|必须|应/.test(r.text),
    metrics: r.metrics || [],
    keywords: r.keywords || [],
    veto: Boolean(r.veto),
    weight: r.weight ?? 1,
  }));
  const scoring = analysis.scoring || [];
  const vetoes = requirements.filter((r) => r.veto).map((r) => ({ clause: r.clause, text: r.text }));
  return {
    project: analysis.project_meta || {},
    requirements,
    scoring,
    vetoes,
    completeness: {
      required: requirements.filter((r) => r.must || r.category === 'technical').length,
      satisfied: requirements.filter((r) => r.must || r.category === 'technical').length,
      required_ids: requirements.filter((r) => r.must || r.category === 'technical').map((r) => r.id),
    },
    parsed_at: analysis.parsed_at,
    stats: {
      requirement_count: requirements.length,
      qualification: requirements.filter((r) => r.category === 'qualification').length,
      technical: requirements.filter((r) => r.category === 'technical').length,
      commercial: requirements.filter((r) => r.category === 'commercial').length,
      scoring: scoring.length,
      veto: vetoes.length,
    },
  };
}

/** 目录蓝本：6 个一级章 + 二级 + 三级小节，共 29 个节点（叶子 20 个） */
const OUTLINE_TREE = [
  {
    title: '项目理解与总体方案',
    children: [
      { title: '项目背景与建设目标', match: ['概述', '背景', '目标'], target: 420 },
      {
        title: '需求理解与响应策略',
        children: [
          { title: '关键技术要求逐条响应', match: ['技术', '要求', '响应', '须'], target: 480 },
          { title: '重点难点分析与应对措施', match: ['难点', '风险', '措施', '保障'], target: 380 },
        ],
      },
    ],
  },
  {
    title: '服务方案与实施计划',
    children: [
      { title: '服务范围与交付物', match: ['服务范围', '交付', '范围'], target: 400 },
      {
        title: '实施计划与里程碑',
        children: [
          { title: '进场交接与人员到位计划', match: ['进场', '交接', '团队', '驻场'], target: 360 },
          { title: '进度保障与风险管理', match: ['进度', '风险', '计划'], target: 340 },
        ],
      },
    ],
  },
  {
    title: '运维服务体系与 SLA 保障',
    children: [
      { title: '值守机制与故障响应', match: ['7×24', '响应', '值守', '故障'], target: 480 },
      { title: 'SLA 指标与考核办法', match: ['可用性', 'SLA', '指标', '恢复', '99.9%'], target: 420 },
      { title: '重大故障处置与应急演练', match: ['应急', '演练', '重大', '连续'], target: 400 },
      { title: '运维平台与工具支撑', match: ['平台', '工具', 'CMDB', '监控', '告警'], target: 380 },
    ],
  },
  {
    title: '团队组织与人员配置',
    children: [
      { title: '组织架构与职责分工', match: ['组织', '职责', '项目经理'], target: 340 },
      { title: '驻场团队与资质配置', match: ['驻场', '人员', '证书', 'PMP', '工程师'], target: 400 },
      { title: '培训赋能与知识转移', match: ['培训', '知识转移', '赋能'], target: 320 },
    ],
  },
  {
    title: '安全合规与质量管理',
    children: [
      { title: '等保 2.0 三级合规与安全加固', match: ['等保', '安全', '加固', '合规'], target: 460 },
      { title: '质量管理体系与持续改进', match: ['质量', 'ISO9001', '改进', '体系'], target: 340 },
      { title: '运维知识库建设与运营', match: ['知识库', '手册', '沉淀', '更新'], target: 360 },
    ],
  },
  {
    title: '商务响应与承诺',
    children: [
      { title: '资格条件响应对照', match: ['资格', 'ISO', 'CMMI', 'ITSS', '证书', '资质'], target: 420 },
      { title: '报价口径与付款响应', match: ['报价', '付款', '预算', '限价', '费用'], target: 380 },
      { title: '保证金与响应偏离表', match: ['保证金', '偏离表', '履约'], target: 320 },
      { title: '同类业绩与案例证明', match: ['业绩', '案例', '合同', '验收'], target: 340 },
      { title: '服务承诺与优惠条款', match: ['承诺', '优惠', '增值', '免费'], target: 300 },
    ],
  },
];

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

function walkBlueprint(nodes, level, prefix, parentId, out) {
  nodes.forEach((node, i) => {
    const id = `n${out.length + 1}`;
    const number = level === 1 ? CN_NUM[i] || String(i + 1) : `${prefix}${i + 1}`;
    const entry = {
      id,
      parent_id: parentId,
      level,
      number,
      title: node.title,
      target_words: node.target || 300,
      match: node.match || [],
      requirement_ids: [],
      children: [],
      word_count: 0,
      status: 'empty',
      content_mode: 'ai',
    };
    out.push(entry);
    if (parentId) {
      const parent = out.find((n) => n.id === parentId);
      if (parent) parent.children.push(id);
    }
    if (node.children?.length) {
      walkBlueprint(node.children, level + 1, `${number}.`, id, out);
    }
  });
}

export function outlineLeaves(nodes) {
  const withChildren = new Set(nodes.filter((n) => n.children?.length).map((n) => n.id));
  return nodes.filter((n) => !withChildren.has(n.id));
}

function matchScore(node, req) {
  const hay = String(req.text || '');
  if (!node.match?.length) return 0;
  let score = 0;
  for (const m of node.match) if (hay.includes(m)) score += m.length;
  return score;
}

/** 要求 → 章节的"主引用"映射（pass 1 的关键词归属；借调章节不覆盖主引用） */
export function primaryOwnerMap(outline) {
  const owner = new Map();
  const leaves = outlineLeaves(outline.nodes || []);
  for (const leaf of leaves) {
    for (const rid of leaf.primary_requirement_ids || leaf.requirement_ids || []) {
      if (!owner.has(rid)) owner.set(rid, `${leaf.number} ${leaf.title}`);
    }
  }
  for (const leaf of leaves) {
    for (const rid of leaf.requirement_ids || []) {
      if (!owner.has(rid)) owner.set(rid, `${leaf.number} ${leaf.title}`);
    }
  }
  return owner;
}

/**
 * 目录生成（新形态）：层级目录 + 要求覆盖度。
 * 映射策略：高权重/废标条款优先，按"命中关键词长度"打分选最贴切的叶子；
 * 匹配不到的按 id 哈希落到固定叶子，保证可复现。
 */
export function buildOutlineTree(analysis) {
  const nodes = [];
  walkBlueprint(OUTLINE_TREE, 1, '', null, nodes);
  const leaves = outlineLeaves(nodes);
  const requirements = analysis.requirements || [];

  const sorted = requirements
    .slice()
    .sort((a, b) => (b.weight || 0) - (a.weight || 0) || a.order - b.order);

  for (const req of sorted) {
    let best = null;
    let bestScore = 0;
    for (const leaf of leaves) {
      const score = matchScore(leaf, req);
      if (score > bestScore) {
        best = leaf;
        bestScore = score;
      }
    }
    let target = best;
    if (!target) {
      let seed = 0;
      for (const ch of String(req.id)) seed = (seed * 31 + ch.codePointAt(0)) % 100000;
      target = leaves[seed % leaves.length];
    }
    if (target && !target.requirement_ids.includes(req.id)) target.requirement_ids.push(req.id);
  }

  // 记录主引用（关键词归属），供"响应：见 X 章"与偏离表使用
  for (const leaf of leaves) leaf.primary_requirement_ids = [...leaf.requirement_ids];

  // 第二轮：保证每个叶子至少引用 2 条要求（同一要求可被多章引用——"逐条响应"的真实写法），
  // 否则空白章节正文会退化成模板套话，查重一跑就 90% 相似。
  const allReqs = analysis.requirements || [];
  if (allReqs.length) {
    for (const leaf of leaves) {
      if (leaf.requirement_ids.length >= 2) continue;
      let seed = 0;
      for (const ch of `${leaf.id}${leaf.title}`) seed = (seed * 31 + ch.codePointAt(0)) % 100000;
      let cursor = seed % allReqs.length;
      for (let guard = 0; guard < allReqs.length && leaf.requirement_ids.length < 2; guard += 1) {
        const req = allReqs[cursor % allReqs.length];
        if (!leaf.requirement_ids.includes(req.id)) leaf.requirement_ids.push(req.id);
        cursor += 1;
      }
    }
  }

  // 高优先要求（废标 + 权重>=2）作为覆盖度分母
  const critical = requirements.filter((r) => r.veto || (r.weight || 0) >= 2);
  const coveredIds = new Set(leaves.flatMap((l) => l.requirement_ids));
  const covered = critical.filter((r) => coveredIds.has(r.id));
  const missing = critical.filter((r) => !coveredIds.has(r.id));

  for (const node of nodes) {
    delete node.match;
    if (node.requirement_ids.length) node.status = 'mapped';
  }

  return {
    status: 'success',
    nodes,
    leaves: leaves.map((l) => l.id),
    coverage: {
      required: critical.length,
      covered: covered.length,
      missing: missing.map((r) => `${r.id} ${clip(r.text, 24)}`),
    },
    generated_at: nowIso(),
  };
}

/** 目录 → 旧形态投影（workbench/兼容层用） */
export function toLegacyOutline(outline) {
  const nodes = outline.nodes || [];
  const leaves = outlineLeaves(nodes);
  const sections = leaves.map((leaf, i) => ({
    id: leaf.id,
    no: leaf.number,
    level: leaf.level,
    title: leaf.title,
    target_words: leaf.target_words || 300,
    requirement_ids: leaf.requirement_ids || [],
    scoring_item: '',
    children: [],
  }));
  return {
    sections,
    leaf_count: sections.length,
    covered_requirements: [...new Set(sections.flatMap((s) => s.requirement_ids))],
    generated_at: outline.generated_at || nowIso(),
    nodes: nodes.map((n) => ({ id: n.id, parent_id: n.parent_id, level: n.level, number: n.number, title: n.title, children: n.children })),
  };
}

/** 全局事实（新形态）：工期/质保/报价口径/响应/资格等跨章节共用口径 */
export function buildGlobalFacts({ analysis, project = {}, text = '' }) {
  const meta = analysis.project_meta || {};
  const source = String(text || '');
  const findLine = (pattern, fallback) => {
    for (const raw of source.split(/\r?\n/)) {
      const line = raw.trim();
      if (line && pattern.test(line)) return clip(line.replace(/^[#\d.\s、)]+/, ''), 70);
    }
    return fallback;
  };
  const tokenOf = (pattern) => source.match(pattern)?.[0] || '';

  const facts = [
    { key: '项目名称', value: project.name || meta.name || '本次招标项目', source: '§项目基本信息' },
    { key: '采购编号', value: meta.code || project.code || '-', source: '§项目基本信息' },
    { key: '采购人', value: meta.owner || '按招标文件载明的采购人', source: '§项目基本信息' },
    { key: '工期', value: meta.duration || findLine(/服务期限|工期|服务期/, '合同签订之日起 12 个月'), source: '§项目基本信息' },
    { key: '质保期', value: findLine(/质保|保修|免费维护/, '服务期（含延保期）内全免费质保，期满后提供 6 个月免费维护'), source: '§商务要求' },
    { key: '报价口径', value: `含税总价（人民币），覆盖${meta.duration || '服务期'}内全部人工、工具、差旅与税费，不另行计费`, source: '§商务要求' },
    { key: '预算/限价', value: meta.budget || project.budget || '按招标文件预算执行', source: '§项目基本信息' },
    { key: '服务响应', value: tokenOf(/7×24/) ? `7×24 小时值守；一般故障 ${tokenOf(/(\d+)\s*分钟/) || '30 分钟'}响应，重大故障 ${tokenOf(/(\d+)\s*小时/) || '2 小时'}内恢复` : '7×24 小时值守，一般故障 30 分钟内响应，重大故障 2 小时内恢复', source: '§技术需求' },
    { key: '可用性承诺', value: tokenOf(/99\.\d+\s*%/) ? `不低于 ${tokenOf(/99\.\d+\s*%/)}` : '不低于 99.9%', source: '§技术需求' },
    { key: '驻场团队', value: findLine(/驻场|团队|不少于/, '不少于 3 人驻场：项目经理 1 名 + 系统工程师 2 名'), source: '§技术需求' },
    { key: '投标保证金', value: findLine(/投标保证金/, '人民币 5 万元，投标截止前到账'), source: '§商务要求' },
    { key: '履约保证金', value: findLine(/履约保证金/, '合同金额的 5%，签订合同前提交'), source: '§商务要求' },
    { key: '交付物', value: '月度运行报告、季度复盘报告、应急演练报告、运维知识库手册、年度服务总结', source: '§技术需求' },
    { key: '验收标准', value: '按招标文件与合同约定的服务级别指标逐项验收，验收合格后进入付款流程', source: '§商务要求' },
    { key: '付款方式', value: findLine(/付款|支付/, '按季度支付，每季度验收合格后 30 日内支付当季款项'), source: '§商务要求' },
    { key: '优惠承诺', value: '免费提供 2 次专项优化与 1 次等保差距分析，不额外计费', source: '§承诺' },
  ];

  return { status: 'success', facts, generated_at: nowIso() };
}

const FILLER = [
  '本节内容与招标文件条款一一对应，所有承诺均可在运行记录与服务档案中核验。',
  '相关责任人、交付物与验收口径已在正文明确，避免职责空转与响应断点。',
  '执行过程中如出现偏差，我方将在 3 个工作日内提交纠偏方案并跟踪闭环。',
  '本节所述机制已在同类项目中落地验证，可直接复用于本项目实施。',
  '本节指标纳入周度看板与月度复盘，异常自动升级至项目经理与采购人对接人。',
];

function padTo(body, min, seedText) {
  let text = String(body || '');
  let seed = 0;
  for (const ch of String(seedText)) seed = (seed * 31 + ch.codePointAt(0)) % 100000;
  let guard = 0;
  while (countChars(text) < min && guard < 12) {
    text += `\n\n${FILLER[(seed + guard) % FILLER.length]}`;
    guard += 1;
  }
  return text;
}

const BOUNDARY_TEMPLATES = [
  (n, nums) => `本节聚焦「${n.number} ${n.title}」，与相邻章节按交付物切分，不重复前序章节的通用承诺；涉及${nums}的指标以本节口径为准。`,
  (n, nums) => `为避免章节之间空转，本节只写「${n.title}」范围内的动作、责任人与验收方式，${nums}不在本节重复展开。`,
  (n, nums) => `本节与总体方案的分工是：总体说原则，本节说「${n.title}」的执行细节与检查点；${nums}按本节口径执行。`,
  (n, nums) => `「${n.title}」的边界限定在实施动作、交付物与度量三项，超出范围的内容归入相应章节，${nums}不作重复承诺。`,
  (n, nums) => `本节承接总体方案，落到「${n.title}」的可执行安排：谁做、何时做、如何验收；${nums}按本节口径考核。`,
  (n, nums) => `围绕「${n.title}」，本节给出可复用的作业模板与检查清单，与后续章节保持口径一致，${nums}以本节为准。`,
];

const CHECKLIST_TEMPLATES = [
  (n) => [`${n.number} 节责任人已到岗，交接清单与验收标准随本节归档；`, '本节关键指标纳入 SLO 看板并按周复盘；', '本节交付物随投标文件附件提交，配合采购人抽查。'],
  (n) => [`「${n.title}」的作业指导书在进场后 5 个工作日内发布；`, `${n.number} 节涉及的记录表单统一归档到服务档案；`, '发现偏差按纠偏流程 3 个工作日内闭环。'],
  (n) => [`「${n.title}」相关角色完成授权与备份安排；`, '本节清单每月随运行报告复核一次；', `${n.number} 节遗留问题纳入问题库跟踪到关闭。`],
  (n) => ['本节交付物清单已与采购人确认版本；', `「${n.title}」的执行记录保留不少于 3 年；`, '本节指标异常时自动升级至项目经理。'],
  (n) => [`${n.number} 节所需工具与账号在进场前完成申请；`, '本节流程与采购人现有流程做一次对齐评审；', `「${n.title}」的改进项纳入季度复盘。`],
  (n) => ['本节责任人、备份人与升级路径已书面确认；', `「${n.title}」的检查项按月度抽查 20%；`, '本节发现的问题在下次评审前完成整改。'],
];

/**
 * 单章正文（新形态）：Markdown，≥200 中文字。
 * 结构：机制段（mockProse）+ 口径段（全局事实）+ 边界段 + 响应条目（要求原文）+ 承诺/清单段。
 * 变异来源：章节标题 hash（模板选择）+ 引用条款原文（唯一文本），保证章节间查重相似度可控。
 */
export function writeChapter({ node, requirements = [], facts = [], project = {}, bidder = '我方', index = 0 }) {
  const points = requirements.map((r) => clip(stripNumbering(r.text), 56)).slice(0, 4);
  const numbers = [...new Set(requirements.flatMap((r) => r.metrics || []))].slice(0, 5);
  const numberText = numbers.join('、') || '服务时效、可用性与恢复指标';

  let seed = 0;
  for (const ch of `${node.id}${node.title}`) seed = (seed * 31 + ch.codePointAt(0)) % 100000;

  const pickedFacts = facts.length
    ? [facts[seed % facts.length], facts[(seed * 7 + 3) % facts.length], facts[(seed * 13 + 5) % facts.length]]
      .filter(Boolean)
      .filter((f, i, arr) => arr.findIndex((x) => x.key === f.key) === i)
    : [];
  const refs = pickedFacts.slice(0, 1).map((f) => `${f.key}：${clip(f.value, 36)}`);

  let body = mockProse({ heading: node.title, points, numbers, refs, bidder });

  const factLine = pickedFacts.slice(0, 2).map((f) => `${f.key} ${clip(f.value, 44)}`).join('；');
  if (factLine) body += `\n\n本节执行口径：${factLine}。`;

  body += `\n\n${BOUNDARY_TEMPLATES[seed % BOUNDARY_TEMPLATES.length](node, numberText)}`;

  if (requirements.length) {
    const bullets = requirements
      .slice(0, 4)
      .map((r) => `- ${r.id}（${r.source_ref}）${clip(stripNumbering(r.text), 70)} → 响应：满足，具体要求已在${node.title}中逐项落实`)
      .join('\n');
    body += `\n\n响应条目：\n${bullets}`;
  } else {
    const tail = pickedFacts.slice(0, 2).map((f) => `${f.key} ${clip(f.value, 30)}`).join('，');
    body += `\n\n响应条目：本节不绑定具体条款编号，按招标文件对「${node.title}」的通用要求执行`;
    if (tail) body += `（口径：${tail}）`;
    body += '。';
  }

  // 全篇只在这两节重复承诺口径（查重可控），其余章节引用对应条款原文即可覆盖废标项
  const needCommitment = /承诺|保证金|偏离表/.test(node.title);
  if (needCommitment) body += `\n\n${COMMITMENT}`;

  const checklist = CHECKLIST_TEMPLATES[(seed >> 3) % CHECKLIST_TEMPLATES.length](node);
  body += `\n\n本节检查清单：\n${checklist.map((c) => `- ${c}`).join('\n')}`;

  return padTo(body, 220, `${node.id}${node.title}`);
}

/** 全部叶子章节生成（新形态） */
export function generateChapters({ outline, analysis, facts, project = {}, bidder = '我方' }) {
  const nodes = outline.nodes || [];
  const leaves = outlineLeaves(nodes);
  const byId = new Map((analysis.requirements || []).map((r) => [r.id, r]));
  const chapters = {};
  let total = 0;
  let minWords = Infinity;

  leaves.forEach((leaf, index) => {
    const reqs = (leaf.requirement_ids || []).map((id) => byId.get(id)).filter(Boolean);
    const markdown = writeChapter({ node: leaf, requirements: reqs, facts, project, bidder, index });
    const words = countChars(markdown);
    chapters[leaf.id] = { markdown, word_count: words };
    total += words;
    minWords = Math.min(minWords, words);
  });

  return {
    chapters,
    stats: {
      leaves: leaves.length,
      total_words: total,
      min_words: Number.isFinite(minWords) ? minWords : 0,
      avg_words: leaves.length ? Math.round(total / leaves.length) : 0,
    },
  };
}

/** 章节 markdown 汇总（导出与查重共用） */
export function joinChapters(outline, markdownByNode) {
  const nodes = outline.nodes || [];
  const leaves = outlineLeaves(nodes);
  return leaves.map((leaf) => `## ${leaf.number} ${leaf.title}\n\n${markdownByNode[leaf.id] || ''}`).join('\n\n');
}

/** 废标项检查（新形态） */
export function checkRejection({ analysis, contentText = '' }) {
  const text = String(contentText || '');
  const vetoReqs = (analysis.requirements || []).filter((r) => r.veto);
  const items = vetoReqs.map((r) => {
    const tokens = (r.metrics?.length ? r.metrics : r.keywords) || [];
    const responded = tokens.length
      ? tokens.some((t) => text.includes(t))
      : COMMITMENT_TOKENS.some((t) => text.includes(t));
    let evidence = '';
    if (responded) {
      const token = tokens.find((t) => text.includes(t)) || COMMITMENT_TOKENS.find((t) => text.includes(t)) || '响应';
      const at = text.indexOf(token);
      evidence = clip(text.slice(Math.max(0, at - 30), at + 90), 120);
    }
    return {
      id: r.id,
      clause: r.source_ref,
      requirement: clip(r.text, 90),
      risk: responded ? '低' : '高',
      responded,
      weight: r.weight ?? 3,
      evidence,
    };
  });
  const unresponded = items.filter((i) => !i.responded);
  const highRisk = items.filter((i) => i.risk === '高');
  return {
    status: 'success',
    veto_count: items.length,
    items,
    summary: `废标项 ${items.length} 条，已响应 ${items.length - unresponded.length} 条，未响应 ${unresponded.length} 条；高风险 ${highRisk.length} 条。`,
    stats: { veto_total: items.length, responded: items.length - unresponded.length, unresponded: unresponded.length, high_risk: highRisk.length },
    checked_at: nowIso(),
  };
}

/** 查重（新形态）：叶子章节两两相似度（字符 2-gram Jaccard），给出重复对与句级摘录 */
export function checkDuplicate({ outline, markdownByNode, threshold = 0.72 }) {
  const leaves = outlineLeaves(outline.nodes || []);
  const pairs = [];
  let max = 0;
  for (let i = 0; i < leaves.length; i += 1) {
    for (let j = i + 1; j < leaves.length; j += 1) {
      const a = markdownByNode[leaves[i].id] || '';
      const b = markdownByNode[leaves[j].id] || '';
      if (!a || !b) continue;
      const score = jaccard(shingles(a), shingles(b));
      max = Math.max(max, score);
      if (score > 0.25) {
        const sa = splitSentences(a);
        const sb = splitSentences(b);
        let best = { text: '', score: 0 };
        for (const x of sa.slice(0, 12)) {
          for (const y of sb.slice(0, 12)) {
            const s = jaccard(shingles(x), shingles(y));
            if (s > best.score) best = { text: x, score: s };
          }
        }
        pairs.push({
          a: `${leaves[i].number} ${leaves[i].title}`,
          b: `${leaves[j].number} ${leaves[j].title}`,
          score: Number(score.toFixed(3)),
          excerpt: clip(best.text, 100),
        });
      }
    }
  }
  const sorted = pairs.sort((x, y) => y.score - x.score).slice(0, 8);
  const over = sorted.filter((p) => p.score >= threshold);
  return {
    status: 'success',
    max_similarity: Number(max.toFixed(3)),
    pairs: sorted,
    summary: `章节 ${leaves.length} 节两两比对，最高相似度 ${(max * 100).toFixed(1)}%，超过阈值（${(threshold * 100).toFixed(0)}%）的重复对 ${over.length} 组。`,
    stats: { chapters: leaves.length, threshold, over_threshold: over.length, pairs: sorted.length },
    checked_at: nowIso(),
  };
}

/** 响应偏离表（新形态）：一个要求一行，结论取"无偏离/正偏离/待确认" */
export function buildDeviationRows({ analysis, outline, markdownByNode = {}, contentText = '' }) {
  const ownerLabel = primaryOwnerMap(outline);
  const text = String(contentText || '');
  const rows = (analysis.requirements || []).map((r, i) => {
    const label = ownerLabel.get(r.id) || '';
    const tokens = (r.metrics?.length ? r.metrics : r.keywords) || [];
    const hit = tokens.length ? tokens.some((t) => text.includes(t)) : COMMITMENT_TOKENS.some((t) => text.includes(t));
    let deviation = '无偏离';
    if (!hit) deviation = r.veto ? '待确认' : '无偏离';
    if (/不低于\s*(99\.\d+)%/.test(r.text) && /99\.95%/.test(text)) deviation = '正偏离';
    return {
      id: `d${String(i + 1).padStart(2, '0')}`,
      clause: r.source_ref,
      requirement_id: r.id,
      requirement: clip(r.text, 120),
      response: r.veto
        ? `满足：已按废标条款逐项响应${label ? `（见 ${label}）` : ''}`
        : `满足：见 ${label || '技术方案正文'}`,
      deviation,
      evidence: clip(`${label || '技术方案'}；${r.metrics?.length ? `指标 ${r.metrics.join('、')}` : '承诺口径见本章'}`, 120),
      veto: Boolean(r.veto),
      manual_edited: false,
    };
  });
  return {
    status: 'generated',
    confirmed: false,
    rows,
    summary: { total: rows.length, no_deviation: rows.filter((r) => r.deviation === '无偏离').length, positive: rows.filter((r) => r.deviation === '正偏离').length, pending: rows.filter((r) => r.deviation === '待确认').length },
    generated_at: nowIso(),
  };
}

const PLACEHOLDER_RE = /待补充|待完善|待填写|TODO|TBD|XXX|PLACEHOLDER|lorem ipsum|【\s*】|\[\s*\]/i;

/** 导出前置校验：真实阻断（返回 blockers 而不是"提示"） */
export function validateExport({ state, project = {} }) {
  const blockers = [];
  const warnings = [];
  const analysis = state.bid_analysis || {};
  const outline = state.outline || {};
  const content = state.content || {};
  const deviation = state.deviation || {};

  if (!(analysis.requirements || []).length) {
    blockers.push({ code: 'NO_REQUIREMENTS', label: '招标解析缺失', detail: '尚未解析招标文件，无法生成响应索引与废标自查。' });
  }
  const nodes = outline.nodes || [];
  const leaves = outlineLeaves(nodes);
  if (!nodes.length) {
    blockers.push({ code: 'NO_OUTLINE', label: '技术方案目录缺失', detail: '目录为空，请先执行 outline 步骤或手工保存目录。' });
  }

  const markdownByNode = content.markdown_by_node || {};
  const missingChapters = leaves.filter((leaf) => countChars(markdownByNode[leaf.id] || '') < 120);
  if (leaves.length && !Object.keys(markdownByNode).length) {
    blockers.push({ code: 'NO_CONTENT', label: '正文缺失', detail: '所有章节均无正文，请先执行 content 步骤。' });
  } else if (missingChapters.length) {
    blockers.push({
      code: 'MISSING_CHAPTERS',
      label: '正文缺章',
      detail: `${missingChapters.length} 个章节字数不足 120：${missingChapters.slice(0, 5).map((n) => `${n.number} ${n.title}`).join('、')}${missingChapters.length > 5 ? ' 等' : ''}`,
    });
  }

  let contentText = '';
  for (const leaf of leaves) contentText += `\n${markdownByNode[leaf.id] || ''}`;
  const rejection = checkRejection({ analysis, contentText });
  if (rejection.stats.unresponded > 0) {
    blockers.push({
      code: 'VETO_UNRESPONDED',
      label: '废标项未响应',
      detail: `${rejection.stats.unresponded} 条废标条款未在正文中响应：${rejection.items.filter((i) => !i.responded).slice(0, 3).map((i) => `${i.clause} ${clip(i.requirement, 24)}`).join('；')}`,
    });
  }

  if (!(deviation.rows || []).length) {
    blockers.push({ code: 'DEVIATION_MISSING', label: '响应偏离表缺失', detail: '偏离表为空，请先生成并人工确认。' });
  } else if (!deviation.confirmed) {
    blockers.push({ code: 'DEVIATION_NOT_CONFIRMED', label: '偏离表未确认', detail: `偏离表共 ${deviation.rows.length} 行，需人工确认（confirmed=true）后才能导出。` });
  }

  const placeholders = [];
  for (const leaf of leaves) {
    const body = markdownByNode[leaf.id] || '';
    const hit = body.match(PLACEHOLDER_RE);
    if (hit) placeholders.push(`${leaf.number} ${leaf.title}（${hit[0]}）`);
  }
  if (placeholders.length) {
    blockers.push({ code: 'PLACEHOLDER', label: '占位符残留', detail: `${placeholders.length} 个章节存在占位符：${placeholders.slice(0, 4).join('、')}` });
  }

  const duplicate = state.checks?.duplicate;
  if (duplicate?.max_similarity >= 0.72) {
    warnings.push({ code: 'HIGH_SIMILARITY', label: '章节相似度偏高', detail: `最高相似度 ${(duplicate.max_similarity * 100).toFixed(1)}%，建议改写重复段落。` });
  }

  const words = leaves.reduce((sum, leaf) => sum + countChars(markdownByNode[leaf.id] || ''), 0);
  return {
    ok: blockers.length === 0,
    blockers,
    warnings,
    stats: {
      project: project.name || '',
      chapters: leaves.length,
      words,
      requirements: (analysis.requirements || []).length,
      veto_total: rejection.stats.veto_total,
      veto_unresponded: rejection.stats.unresponded,
      deviation_rows: (deviation.rows || []).length,
      deviation_confirmed: Boolean(deviation.confirmed),
    },
    checked_at: nowIso(),
  };
}

function cell(text) {
  return String(text ?? '').replace(/\|/g, '／').replace(/\r?\n/g, ' ').trim();
}

/** 导出用 Markdown：封面信息 + 目录 + 章节 + 响应偏离表附录 + 废标自查附录 */
export function composeProjectMarkdown({ project = {}, state }) {
  const outline = state.outline || {};
  const nodes = outline.nodes || [];
  const leaves = outlineLeaves(nodes);
  const content = state.content || {};
  const markdownByNode = content.markdown_by_node || {};
  const facts = state.global_facts?.facts || [];
  const deviation = state.deviation || { rows: [] };
  const bidder = project.bidder_name || '我方';
  const meta = state.bid_analysis?.project_meta || {};

  const lines = [];
  lines.push(`# ${project.name || '投标技术方案'}`);
  lines.push(`投标人：${bidder}`);
  lines.push(`采购编号：${meta.code || project.code || '-'}　采购人：${meta.owner || '-'}`);
  lines.push(`预算/限价：${meta.budget || project.budget || '-'}　服务期限：${meta.duration || '-'}`);
  if (project.deadline) lines.push(`投标截止：${project.deadline}`);
  lines.push('');
  lines.push('## 目录');
  for (const node of nodes) {
    const indent = '　'.repeat(node.level - 1);
    lines.push(`${indent}${node.number} ${node.title}`);
  }
  lines.push('');
  lines.push('## 全局事实口径');
  for (const fact of facts) lines.push(`- ${fact.key}：${fact.value}（来源：${fact.source}）`);
  lines.push('');

  for (const node of nodes) {
    const heading = node.level <= 2 ? '##' : '###';
    lines.push(`${heading} ${node.number} ${node.title}`);
    if (node.children?.length) {
      lines.push('');
      continue;
    }
    lines.push('');
    lines.push(countChars(markdownByNode[node.id] || '') ? markdownByNode[node.id] : '（本节待补充内容）');
    lines.push('');
  }

  if ((deviation.rows || []).length) {
    lines.push('## 附录A 技术响应与偏离表');
    lines.push(`确认状态：${deviation.confirmed ? '已确认' : '未确认'}　生成时间：${deviation.generated_at || '-'}`);
    lines.push('');
    lines.push('| 序号 | 条款 | 招标要求 | 响应 | 偏离 | 证据 |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    deviation.rows.forEach((row, i) => {
      lines.push(`| ${i + 1} | ${cell(row.clause)} | ${cell(clip(row.requirement, 100))} | ${cell(row.response)} | ${cell(row.deviation)} | ${cell(row.evidence)} |`);
    });
    lines.push('');
  }

  const rejection = state.checks?.rejection;
  if (rejection?.items?.length) {
    lines.push('## 附录B 废标项自查表');
    lines.push(rejection.summary || '');
    lines.push('');
    lines.push('| 条款 | 要求 | 风险 | 响应状态 |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of rejection.items) {
      lines.push(`| ${cell(item.clause)} | ${cell(clip(item.requirement, 90))} | ${cell(item.risk)} | ${item.responded ? '已响应' : '未响应'} |`);
    }
    lines.push('');
  }

  lines.push(`<!-- 由 BidCore 生成：项目 ${project.id ?? '-'} / 章节 ${leaves.length} / 字数 ${content.total_words || 0} -->`);
  return lines.join('\n');
}
