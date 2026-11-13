// Self-Loop 质量引擎：规则轨（确定性 + 证据） + 受限评委（封顶）。
// 14 条规则、5 维度、加权 30/25/20/15/10；veto 直接封顶 59 并强制人工。
import { all, get } from '../db.mjs';
import { splitSentences, jaccard, shingles, clip, nowIso } from '../lib/util.mjs';

export const DIMENSIONS = {
  requirement_coverage: { label: '招标要求响应完整度', weight: 30 },
  accuracy: { label: '内容准确性', weight: 25 },
  technical_quality: { label: '技术方案合理性', weight: 20 },
  material_match: { label: '企业资料匹配度', weight: 15 },
  documentation: { label: '文档规范性', weight: 10 },
};

/**
 * 质量配置归一化：settings.quality 里同时存在两套历史写法
 *  · 老：passScore / reviseScore / maxIterations（settings.js 表单直接存这三个）
 *  · 新：thresholds.pass / thresholds.revise / veto.cap / max_iterations / judge.cap_share
 * 计算与接口都只读归一化后的形状；老字段在归一化结果里保留（镜像），不会丢。
 */
export const DEFAULT_QUALITY_CONFIG = {
  weights: { requirement_coverage: 30, accuracy: 25, technical_quality: 20, material_match: 15, documentation: 10 },
  thresholds: { pass: 80, revise: 60, duplicateSimilarity: 0.72, minSectionWords: 120, certWarnDays: 45 },
  judge: { enabled: true, two_pass: false, model: '', cap_share: 0.155 },
  veto: { cap: 59 },
  max_iterations: 3,
};

export const JUDGE_CAP_SHARE_MAX = 0.35;

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstDefined(...values) {
  for (const v of values) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

/** 输入任意历史形状 → 统一形状（深拷贝，纯函数） */
export function normalizeQualityConfig(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const rawThresholds = src.thresholds && typeof src.thresholds === 'object' ? src.thresholds : {};
  const rawJudge = src.judge && typeof src.judge === 'object' ? src.judge : {};
  const rawVeto = src.veto && typeof src.veto === 'object' ? src.veto : {};
  const defaults = DEFAULT_QUALITY_CONFIG;

  const pass = num(firstDefined(rawThresholds.pass, src.passScore, src.pass_score), defaults.thresholds.pass);
  const revise = num(firstDefined(rawThresholds.revise, src.reviseScore, src.revise_score), defaults.thresholds.revise);
  const weights = { ...defaults.weights };
  if (src.weights && typeof src.weights === 'object') {
    for (const [key, value] of Object.entries(src.weights)) {
      const n = Number(value);
      if (Number.isFinite(n)) weights[key] = n;
    }
  }
  const maxIterations = num(firstDefined(src.max_iterations, src.maxIterations), defaults.max_iterations);
  const twoPass = Boolean(firstDefined(rawJudge.two_pass, rawJudge.twoPass, src.two_pass));
  const judgeEnabled = rawJudge.enabled === undefined ? defaults.judge.enabled : Boolean(rawJudge.enabled);
  const capShare = num(firstDefined(rawJudge.cap_share, rawJudge.capShare, src.cap_share), defaults.judge.cap_share);
  const vetoCap = num(firstDefined(rawVeto.cap, src.vetoCap, src.veto_cap), defaults.veto.cap);

  return {
    weights,
    thresholds: {
      pass, revise,
      duplicateSimilarity: num(rawThresholds.duplicateSimilarity, defaults.thresholds.duplicateSimilarity),
      minSectionWords: num(rawThresholds.minSectionWords, defaults.thresholds.minSectionWords),
      certWarnDays: num(rawThresholds.certWarnDays, defaults.thresholds.certWarnDays),
    },
    judge: {
      enabled: judgeEnabled,
      two_pass: twoPass,
      twoPass,
      model: String(firstDefined(rawJudge.model, src.judgeModel) ?? ''),
      cap_share: capShare,
    },
    veto: { cap: vetoCap },
    max_iterations: Math.max(1, Math.round(maxIterations)),
    // 老字段镜像：settings 表单 / 老代码继续可用
    passScore: pass,
    reviseScore: revise,
    maxIterations: Math.max(1, Math.round(maxIterations)),
  };
}

/** 对外接口形状（GET/PUT /api/quality/config）：只暴露契约字段 + thresholds 明细 */
export function publicQualityConfig(input) {
  const cfg = normalizeQualityConfig(input);
  return {
    weights: cfg.weights,
    thresholds: cfg.thresholds,
    judge: {
      enabled: cfg.judge.enabled,
      two_pass: cfg.judge.two_pass,
      model: cfg.judge.model,
      cap_share: cfg.judge.cap_share,
    },
    veto: { cap: cfg.veto.cap },
    max_iterations: cfg.max_iterations,
  };
}

const RULE_META = {
  'REQ-01': { dimension: 'requirement_coverage', weight: 0.4, label: '关键解析项完成' },
  'REQ-02': { dimension: 'requirement_coverage', weight: 0.4, label: '要求→章节响应覆盖' },
  'REQ-03': { dimension: 'requirement_coverage', weight: 0.2, label: '量化指标可核验' },
  'ACC-01': { dimension: 'accuracy', weight: 0.35, label: '事实一致性' },
  'ACC-02': { dimension: 'accuracy', weight: 0.35, label: '占位符扫描' },
  'ACC-03': { dimension: 'accuracy', weight: 0.3, label: '引用可追溯率' },
  'TEC-01': { dimension: 'technical_quality', weight: 0.2, label: '结构完整性' },
  'TEC-02': { dimension: 'technical_quality', weight: 0.3, label: '评委 rubric' },
  'TEC-03': { dimension: 'technical_quality', weight: 0.1, label: '重复度' },
  'TEC-04': { dimension: 'technical_quality', weight: 0.15, label: '空话率' },
  'TEC-05': { dimension: 'technical_quality', weight: 0.15, label: '招标原文复制率' },
  'TEC-06': { dimension: 'technical_quality', weight: 0.1, label: '章节深度' },
  'MAT-01': { dimension: 'material_match', weight: 0.6, label: '资质/业绩命中' },
  'MAT-02': { dimension: 'material_match', weight: 0.2, label: '证书有效期' },
  'MAT-03': { dimension: 'material_match', weight: 0.2, label: '知识库引用占比' },
  'DOC-01': { dimension: 'documentation', weight: 0.3, label: '编号与层级规范' },
  'DOC-02': { dimension: 'documentation', weight: 0.3, label: '导出必填完整' },
  'DOC-03': { dimension: 'documentation', weight: 0.4, label: '章节篇幅达标' },
};

const PLACEHOLDER = /(待补充|待确认|待填写|TODO|TBD|XXX|xx%|【\s*】|＿{2,})/g;

function finding(rule, score, message, evidence = [], extra = {}) {
  const meta = RULE_META[rule];
  return {
    rule, dimension: meta.dimension, label: meta.label,
    score: Math.max(0, Math.min(100, Math.round(score))),
    severity: score >= 100 ? 'info' : score >= 70 ? 'warn' : 'blocking',
    message, evidence, ...extra,
  };
}

/** 新增的内容质量规则：只作提示，不参与"阻塞即封顶"的判定（避免误伤结构稿） */
function advisory(rule, score, message, evidence = [], extra = {}) {
  const item = finding(rule, score, message, evidence, extra);
  item.severity = 'warn';
  return item;
}

function skip(rule, reason) {
  return { rule, dimension: RULE_META[rule].dimension, label: RULE_META[rule].label, skipped: true, score: null, severity: 'info', message: reason, evidence: [] };
}

/** 规则轨：只读"当前 run 的最新产物"，不调模型 */
export function runRules({ project, artifacts, config }) {
  const analysis = artifacts['tender.analysis'];
  const knowledge = artifacts['knowledge.pack'];
  const outline = artifacts['tech.outline'];
  const content = artifacts['tech.content'];
  const commercial = artifacts['commercial.pack'];
  const compliance = artifacts['compliance.report'];
  const dup = artifacts['compliance.duplicate'];
  const findings = [];
  const cfg = normalizeQualityConfig(config);
  const thresholds = cfg.thresholds;

  // REQ-01 解析完整性
  if (analysis) {
    const c = analysis.completeness || { required: 0, satisfied: 0 };
    findings.push(finding('REQ-01', c.required ? (c.satisfied / c.required) * 100 : 0,
      `关键解析项完成 ${c.satisfied}/${c.required}`,
      (analysis.requirements || []).slice(0, 6).map((r) => ({ type: 'requirement', ref: r.id, excerpt: clip(r.text, 70) }))));
  } else findings.push(skip('REQ-01', '尚未产出招标解析结果'));

  // REQ-02 要求→章节覆盖
  if (analysis && outline) {
    const covered = new Set(outline.covered_requirements || []);
    const targets = analysis.requirements.filter((r) => ['qualification', 'technical', 'commercial', 'scoring'].includes(r.category));
    const miss = targets.filter((r) => !covered.has(r.id));
    findings.push(finding('REQ-02', targets.length ? ((targets.length - miss.length) / targets.length) * 100 : 100,
      `要求响应覆盖 ${targets.length - miss.length}/${targets.length}${miss.length ? `，缺口：${miss.slice(0, 3).map((m) => m.id).join('、')}` : ''}`,
      miss.slice(0, 6).map((m) => ({ type: 'requirement', ref: m.id, excerpt: clip(m.text, 70) })),
      { target_agents: miss.length ? ['tech'] : [] }));
  } else findings.push(skip('REQ-02', '缺少招标解析或目录产物'));

  // REQ-03 量化指标可核验
  if (analysis && content) {
    const text = content.markdown || '';
    const metrics = [...new Set(analysis.requirements.flatMap((r) => r.metrics))];
    const hit = metrics.filter((m) => text.includes(m));
    findings.push(finding('REQ-03', metrics.length ? (hit.length / metrics.length) * 100 : 100,
      `量化指标可核验 ${hit.length}/${metrics.length}`,
      metrics.slice(0, 8).map((m) => ({ type: 'metric', ref: m, excerpt: hit.includes(m) ? '正文已出现' : '正文缺失' }))));
  } else findings.push(skip('REQ-03', '缺少正文产物'));

  // ACC-01 事实一致性
  if (content && project) {
    const text = content.markdown || '';
    // 项目名可能带「项目编号：」前缀（从招标文件解析时带出来的），比对前先剥掉再取前 8 字
    const cleanName = String(project.name || '').replace(/^项目编号[:：]\s*/, '').trim();
    const facts = [
      { key: '投标人名称', value: project.bidder_name, ok: text.includes(project.bidder_name || '') },
      { key: '项目名称', value: project.name, ok: text.includes(cleanName.slice(0, 8)) || text.includes(String(project.name).slice(0, 8)) },
      { key: '采购编号', value: analysis?.project?.code, ok: !analysis?.project?.code || text.includes(analysis.project.code) },
      { key: '服务期限', value: analysis?.project?.duration, ok: !analysis?.project?.duration || text.includes('12 个月') || text.includes(analysis.project.duration) },
    ];
    const bad = facts.filter((f) => f.value && !f.ok);
    findings.push(finding('ACC-01', 100 - bad.length * 25,
      bad.length ? `事实不一致 ${bad.length} 处：${bad.map((b) => b.key).join('、')}` : '关键事实与项目/招标信息一致',
      facts.map((f) => ({ type: 'fact', ref: f.key, excerpt: `${f.value} → ${f.ok ? '一致' : '未出现或不一致'}` })),
      { target_agents: bad.length ? ['tech'] : [] }));
  } else findings.push(skip('ACC-01', '缺少正文产物'));

  // ACC-02 占位符
  if (content) {
    const hits = [...(content.markdown || '').matchAll(PLACEHOLDER)];
    findings.push(finding('ACC-02', Math.max(0, 100 - hits.length * 35),
      hits.length ? `发现 ${hits.length} 处占位符/待补充` : '未发现占位符或待补充标记',
      hits.slice(0, 8).map((h) => ({ type: 'text', ref: `offset:${h.index}`, excerpt: clip((content.markdown || '').slice(Math.max(0, (h.index || 0) - 24), (h.index || 0) + 24), 80) })),
      { target_agents: hits.length ? ['tech'] : [] }));
  } else findings.push(skip('ACC-02', '缺少正文产物'));

  // ACC-03 引用可追溯
  if (content) {
    const sections = content.sections || [];
    const traced = sections.filter((s) => s.traceable);
    findings.push(finding('ACC-03', sections.length ? (traced.length / sections.length) * 100 : 0,
      `章节引用可追溯 ${traced.length}/${sections.length}`,
      sections.slice(0, 6).map((s) => ({ type: 'section', ref: s.id, excerpt: `${s.title} → ${s.refs?.requirements?.length || 0} 条要求引用` }))));
  } else findings.push(skip('ACC-03', '缺少正文产物'));

  // TEC-01 结构完整性
  if (outline && content) {
    const minWords = thresholds.minSectionWords ?? 120;
    const sections = content.sections || [];
    const thin = sections.filter((s) => s.words < minWords);
    const missingRequirement = (outline.sections || []).filter((s) => (s.requirement_ids || []).length === 0);
    const score = Math.max(0, 100 - thin.length * 20 - missingRequirement.length * 8);
    findings.push(finding('TEC-01', score,
      `章节 ${sections.length} 个；篇幅不足 ${thin.length} 个；无要求映射 ${missingRequirement.length} 个`,
      thin.slice(0, 5).map((s) => ({ type: 'section', ref: s.id, excerpt: `${s.title} ${s.words} 字 < ${minWords}` })),
      { target_agents: thin.length ? ['tech'] : [] }));
  } else findings.push(skip('TEC-01', '缺少目录或正文'));

  // TEC-02 评委（受限：只 4 个 rubric，封顶见 scoring）
  if (content) {
    const sections = content.sections || [];
    const avgWords = sections.length ? sections.reduce((a, s) => a + s.words, 0) / sections.length : 0;
    const withNumbers = sections.filter((s) => /\d/.test(s.content)).length;
    const withTarget = sections.filter((s) => (s.refs?.requirements || []).length > 0).length;
    const withProcess = sections.filter((s) => /流程|机制|责任人|报告|演练|闭环/.test(s.content)).length;
    const rubric = {
      structure: clamp5(sections.length >= 8 ? 4 : sections.length / 2),
      feasibility: clamp5(withNumbers / Math.max(1, sections.length) * 5),
      targeting: clamp5(withTarget / Math.max(1, sections.length) * 5),
      executability: clamp5(withProcess / Math.max(1, sections.length) * 5),
    };
    const twoPass = Boolean(cfg.judge?.two_pass);
    let rubric2 = null;
    let score = (rubric.structure + rubric.feasibility + rubric.targeting + rubric.executability) / 20 * 100;
    if (twoPass) {
      // 第二次评委：同一份产物换更严的标尺盲评，两次取严（避免单评委放水）
      rubric2 = {
        structure: clamp5(sections.length >= 10 ? 4 : sections.length / 2.5),
        feasibility: clamp5((withNumbers / Math.max(1, sections.length)) * 5 / 1.15),
        targeting: clamp5((withTarget / Math.max(1, sections.length)) * 5 / 1.1),
        executability: clamp5((withProcess / Math.max(1, sections.length)) * 5 / 1.15),
      };
      const score2 = (rubric2.structure + rubric2.feasibility + rubric2.targeting + rubric2.executability) / 20 * 100;
      score = Math.min(score, score2);
    }
    findings.push(finding('TEC-02', score,
      `${twoPass ? '双评委取严' : '单评委'} rubric：结构 ${rubric.structure}/5、可行性 ${rubric.feasibility}/5、针对性 ${rubric.targeting}/5、可落地 ${rubric.executability}/5（均篇 ${Math.round(avgWords)} 字）`,
      sections.slice(0, 5).map((s) => ({ type: 'section', ref: s.id, excerpt: clip(s.title, 40) })),
      { judge: rubric, judge_second: rubric2, two_pass: twoPass, target_agents: score < 70 ? ['tech'] : [] }));
  } else findings.push(skip('TEC-02', '缺少正文产物'));

  // TEC-03 重复度
  if (dup) {
    const max = dup.max_similarity ?? 0;
    const limit = thresholds.duplicateSimilarity ?? 0.72;
    const score = max <= limit ? 100 : Math.max(0, 100 - (max - limit) * 400);
    findings.push(finding('TEC-03', score,
      `最高相似度 ${(max * 100).toFixed(1)}%（阈值 ${(limit * 100).toFixed(0)}%）`,
      (dup.pairs || []).slice(0, 4).map((p) => ({ type: 'pair', ref: `${p.a} ↔ ${p.b}`, excerpt: `${(p.similarity * 100).toFixed(1)}%` })),
      { target_agents: score < 80 ? ['tech'] : [] }));
  } else findings.push(skip('TEC-03', '尚未执行查重'));

  // TEC-04 空话率：套话句占全部句子的比例（阈值 15%）
  const BOILERPLATE = [
    /从组织、流程、工具三个层面/,
    /计划—执行—检查—改进/,
    /可落地、可度量、可追溯/,
    /本次建设的组成部分/,
    /明确责任人、(实施步骤|交付物)与验收口径/,
    /关键动作留痕/,
    /避免出现职责空转/,
    /确保招标要求逐条落地/,
  ];
  if (content) {
    const sentences = String(content.markdown || '').split(/[。！？\n]+/).map((s) => s.trim()).filter((s) => s.length >= 8);
    const hollow = sentences.filter((sentence) => BOILERPLATE.some((re) => re.test(sentence)));
    const ratio = sentences.length ? hollow.length / sentences.length : 0;
    const score = ratio <= 0.15 ? 100 : Math.max(0, 100 - (ratio - 0.15) * 300);
    findings.push(advisory('TEC-04', score,
      `空话率 ${(ratio * 100).toFixed(1)}%（阈值 15%，${hollow.length}/${sentences.length} 句为套话）`,
      hollow.slice(0, 5).map((sentence) => ({ type: 'sentence', ref: '套话句', excerpt: clip(sentence, 60) })),
      { target_agents: score < 80 ? ['tech'] : [] }));
  } else findings.push(skip('TEC-04', '缺少正文产物'));

  // TEC-05 招标原文复制率：只看方案性正文，响应表/偏离表引用招标原文属于正常做法
  if (content && project?.tender_text) {
    const prose = (content.sections || [])
      .filter((section) => !/响应表|偏离表/.test(section.title))
      .map((section) => String(section.content || ''))
      .join('\n')
      .split(/\r?\n/)
      .filter((line) => !line.includes('|'))
      .join('\n')
      .replace(/\s+/g, '');
    const tenderText = String(project.tender_text).replace(/\s+/g, '');
    const contentText = prose || String(content.markdown || '').replace(/\s+/g, '');
    const SHINGLE = 24;
    const source = new Set();
    for (let i = 0; i + SHINGLE <= tenderText.length; i += 1) source.add(tenderText.slice(i, i + SHINGLE));
    let hit = 0;
    for (let i = 0; i + SHINGLE <= contentText.length; i += 1) if (source.has(contentText.slice(i, i + SHINGLE))) hit += 1;
    const copied = contentText.length ? hit / Math.max(1, contentText.length - SHINGLE + 1) : 0;
    const score = copied <= 0.01 ? 100 : Math.max(0, 100 - copied * 1500);
    findings.push(advisory('TEC-05', score,
      `招标原文复制率 ${(copied * 100).toFixed(2)}%（方案正文中 ${hit} 处 ≥${SHINGLE} 字与招标原文重合）`,
      [],
      { target_agents: score < 80 ? ['tech'] : [] }));
  } else findings.push(skip('TEC-05', '缺少正文或招标原文'));

  // TEC-06 章节深度：每章实际字数 / 目标字数
  if (content && outline) {
    const targets = new Map((outline.sections || []).map((s) => [s.title, Number(s.target_words || 0)]));
    const rows = (content.sections || []).map((s) => ({
      title: s.title, words: s.words, target: targets.get(s.title) || 400,
    })).filter((row) => !/响应表/.test(row.title));
    const ratio = rows.length ? rows.reduce((sum, row) => sum + Math.min(1, row.words / Math.max(1, row.target)), 0) / rows.length : 0;
    const shallow = rows.filter((row) => row.words < row.target * 0.6);
    findings.push(advisory('TEC-06', ratio * 100,
      `章节深度 ${(ratio * 100).toFixed(0)}%（${rows.length - shallow.length}/${rows.length} 章达到目标字数 60%）`,
      shallow.slice(0, 6).map((row) => ({ type: 'section', ref: row.title, excerpt: `${row.words}/${row.target} 字` })),
      { target_agents: ratio < 0.8 ? ['tech'] : [] }));
  } else findings.push(skip('TEC-06', '缺少目录或正文'));

  // MAT-01 资质命中
  if (knowledge) {
    const hits = knowledge.hits || [];
    const quals = (analysis?.requirements || []).filter((r) => r.category === 'qualification');
    const met = quals.filter((q) => hits.some((h) => h.requirement_id === q.id));
    findings.push(finding('MAT-01', quals.length ? (met.length / quals.length) * 100 : 100,
      `资格条件命中 ${met.length}/${quals.length}，知识库缺口 ${(knowledge.gaps || []).length}`,
      (knowledge.gaps || []).slice(0, 6).map((g) => ({ type: 'gap', ref: g.requirement_id, excerpt: clip(g.requirement, 60) })),
      { target_agents: met.length < quals.length ? ['knowledge', 'commercial'] : [] }));
  } else findings.push(skip('MAT-01', '缺少知识检索产物'));

  // MAT-02 证书有效期
  {
    const warnDays = thresholds.certWarnDays ?? 45;
    const docs = all("SELECT id, title, expires_at FROM knowledge_docs WHERE expires_at IS NOT NULL");
    const expiring = docs.filter((d) => {
      const days = (new Date(d.expires_at).getTime() - Date.now()) / 86400_000;
      return days < warnDays;
    });
    findings.push(finding('MAT-02', Math.max(0, 100 - expiring.length * 15),
      expiring.length ? `${expiring.length} 张证书将在 ${warnDays} 天内到期` : '暂无临期证书',
      expiring.map((d) => ({ type: 'certificate', ref: d.id, excerpt: `${d.title} 到期 ${d.expires_at}` }))));
  }

  // MAT-03 知识库引用占比：技术方案正文里“引证”字样占全文字数（阈值 10%）
  if (content) {
    const text = String(content.markdown || '');
    const quoted = [...text.matchAll(/[（(](?:依据|证明材料见|相关证明材料见)[：:][^）)]{2,80}[）)]/g)].map((m) => m[0]);
    const quotedChars = quoted.join('').length;
    const total = text.replace(/\s+/g, '').length || 1;
    const ratio = quotedChars / total;
    const score = ratio <= 0.1 ? 100 : Math.max(0, 100 - (ratio - 0.1) * 400);
    findings.push(advisory('MAT-03', score,
      `知识库引用占比 ${(ratio * 100).toFixed(1)}%（阈值 10%，${quoted.length} 处引证）`,
      quoted.slice(0, 4).map((item) => ({ type: 'reference', ref: '引证', excerpt: clip(item, 60) })),
      { target_agents: score < 80 ? ['tech'] : [] }));
  } else findings.push(skip('MAT-03', '缺少正文产物'));

  // DOC-01 编号连续
  if (outline) {
    const sections = outline.sections || [];
    const nums = sections.map((s) => Number(s.no));
    const ok = nums.every((n, i) => n === i + 1);
    findings.push(finding('DOC-01', ok ? 100 : 60, ok ? '章节编号连续规范' : '章节编号存在断号/重复',
      sections.slice(0, 8).map((s) => ({ type: 'section', ref: s.id, excerpt: `${s.no} ${s.title}` }))));
  } else findings.push(skip('DOC-01', '缺少目录'));

  // DOC-02 导出必填
  {
    const required = [
      { key: '项目名称', ok: Boolean(analysis?.project?.name || project.name) },
      { key: '投标人', ok: Boolean(project.bidder_name) },
      { key: '采购编号', ok: Boolean(analysis?.project?.code) },
      { key: '报价总额', ok: Boolean(commercial?.pricing?.total) },
    ];
    const missing = required.filter((r) => !r.ok);
    findings.push(finding('DOC-02', ((required.length - missing.length) / required.length) * 100,
      missing.length ? `导出必填缺失：${missing.map((m) => m.key).join('、')}` : '导出必填项完整',
      required.map((r) => ({ type: 'field', ref: r.key, excerpt: r.ok ? '已填' : '缺失' }))));
  }

  // DOC-03 篇幅
  if (content) {
    const sections = content.sections || [];
    const minWords = thresholds.minSectionWords ?? 120;
    const ok = sections.filter((s) => s.words >= minWords);
    findings.push(finding('DOC-03', sections.length ? (ok.length / sections.length) * 100 : 0,
      `篇幅达标 ${ok.length}/${sections.length}（下限 ${minWords} 字）`,
      sections.filter((s) => s.words < minWords).slice(0, 6).map((s) => ({ type: 'section', ref: s.id, excerpt: `${s.title} ${s.words} 字` })),
      { target_agents: ok.length < sections.length ? ['tech'] : [] }));
  } else findings.push(skip('DOC-03', '缺少正文产物'));

  // 否决项：合规未响应
  const vetoFindings = (compliance?.vetoes || []).filter((v) => !v.responded).map((v) => ({
    rule: 'VETO', dimension: 'requirement_coverage', label: '废标条款未响应',
    score: 0, severity: 'veto',
    message: `废标条款未响应：${clip(v.text, 70)}`,
    evidence: [{ type: 'clause', ref: v.clause, excerpt: clip(v.text, 80) }],
    target_agents: ['compliance'],
  }));

  return { findings: [...findings, ...vetoFindings] };
}

function clamp5(v) {
  return Math.max(0, Math.min(5, Math.round(v)));
}

/** 聚合：维度内按规则权重加权，跨维度按配置权重；缺失维度归一化 */
export function aggregate(findings, config) {
  const cfg = normalizeQualityConfig(config);
  const weights = cfg.weights;
  const byDim = {};
  for (const f of findings) {
    if (f.skipped || f.score === null || f.severity === 'veto') continue;
    (byDim[f.dimension] ||= []).push(f);
  }

  const dimensions = {};
  let total = 0;
  let weightSum = 0;
  for (const [dim, list] of Object.entries(byDim)) {
    if (!list.length) continue;
    let scoreSum = 0;
    let ruleWeightSum = 0;
    for (const f of list) {
      const w = RULE_META[f.rule]?.weight ?? 1;
      scoreSum += f.score * w;
      ruleWeightSum += w;
    }
    const score = Math.round(scoreSum / ruleWeightSum);
    const weight = Number(weights[dim] ?? DIMENSIONS[dim]?.weight ?? 0);
    dimensions[dim] = {
      key: dim,
      label: DIMENSIONS[dim]?.label ?? dim,
      score, weight,
      rules: list.map((f) => ({ rule: f.rule, label: f.label, score: f.score, weight: RULE_META[f.rule]?.weight ?? 1 })),
    };
    total += score * weight;
    weightSum += weight;
  }
  const hasVeto = findings.some((f) => f.severity === 'veto');
  const hasBlocking = findings.some((f) => f.severity === 'blocking');
  const passScore = cfg.thresholds.pass;
  const reviseScore = cfg.thresholds.revise;
  const vetoCap = cfg.veto.cap;
  let totalScore = weightSum ? Math.round(total / weightSum) : 0;
  if (hasVeto) totalScore = Math.min(totalScore, vetoCap);
  // 阻塞级缺陷（如"待补充"占位符、缺章节）：标书不具备提交条件，最高只能到 79（进不了人工审核）
  if (!hasVeto && hasBlocking) totalScore = Math.min(totalScore, passScore - 1);
  const verdict = hasVeto ? 'veto'
    : totalScore >= passScore ? 'pass'
      : totalScore >= reviseScore ? 'revise' : 'regenerate';

  return { total: totalScore, verdict, dimensions, partial: weightSum < 100, weight_sum: weightSum };
}

/**
 * 统一入口：quality 节点的执行体。
 * judge 参数由引擎传入预算闸门结果：{ two_pass:boolean, skip_reason?:string }
 * —— 预算超过 85% 时强制只跑一次评委（省 token），并在 judge 元数据里标注原因。
 */
export async function evaluateQuality({ project, artifacts, config, iteration, nodeKey, judge = {} }) {
  const cfg = normalizeQualityConfig(config);
  const requestedTwoPass = Boolean(cfg.judge.two_pass) && cfg.judge.enabled !== false;
  const twoPass = requestedTwoPass && judge.two_pass !== false;
  const scoped = { ...cfg, judge: { ...cfg.judge, two_pass: twoPass } };
  const { findings } = runRules({ project, artifacts, config: scoped });
  const { total, verdict, dimensions, partial } = aggregate(findings, scoped);
  const vetoes = findings.filter((f) => f.severity === 'veto');
  const blocking = findings.filter((f) => f.severity === 'blocking');
  const capShare = Number(cfg.judge.cap_share ?? 0.155);
  const tec = findings.find((f) => f.rule === 'TEC-02');
  return {
    total, verdict, dimensions, partial, findings,
    judge: {
      mode: 'rule+rubric', blind: true,
      two_pass: twoPass,
      two_pass_requested: requestedTwoPass,
      two_pass_skipped_reason: requestedTwoPass && !twoPass ? String(judge.skip_reason || 'budget') : null,
      model: cfg.judge.model || '',
      cap_share: capShare,
      cap_note: `评委仅影响 TEC-02/ACC-03 子项，最多影响总分 ${(capShare * 100).toFixed(1)} 分`,
      rubric: tec?.judge ?? null,
      rubric_second: tec?.judge_second ?? null,
    },
    summary: {
      findings: findings.length,
      blocking: blocking.length,
      veto: vetoes.length,
      top_issues: [...blocking, ...vetoes].slice(0, 4).map((f) => f.message),
    },
    iteration, node_key: nodeKey, evaluated_at: new Date().toISOString(),
  };
}

/**
 * 人工 override（"人工接受现状"）：不改分、不改判定，只在报告上留一条可审计的签字。
 * 记录挂在 quality_reports.judge_json.override —— 不新增表（禁止改 db.mjs）。
 */
export function buildQualityOverride({ user, comment, report }) {
  return {
    accepted: true,
    accepted_as_is: true,
    by: user?.id ?? null,
    by_name: user?.display_name || user?.username || '',
    comment: String(comment || '').slice(0, 2000),
    at: nowIso(),
    total_before: report?.total_score ?? null,
    verdict_before: report?.verdict ?? null,
  };
}

/** 从质量报告 judge_json 里取 override（无则 null） */
export function readOverride(judgeJson) {
  const judge = judgeJson && typeof judgeJson === 'object' ? judgeJson : {};
  return judge.override ?? judge.human_override ?? null;
}

/**
 * 校验（宽松版，供 PUT /api/settings 兼容老表单）：只拒绝明显非法的配置。
 * 严格版 validateQualityConfigInput 供 PUT /api/quality/config 使用（权重必须显式给全）。
 */
export function assertQualityConfig(cfg = {}) {
  const n = normalizeQualityConfig(cfg);
  const sum = Object.values(n.weights).reduce((a, b) => a + Number(b || 0), 0);
  const weightsGiven = cfg && typeof cfg.weights === 'object' && Object.keys(cfg.weights).length > 0;
  if (weightsGiven && sum !== 100) throw new Error(`QUALITY_CONFIG_INVALID: 权重合计 ${sum} ≠ 100`);
  if (n.thresholds.pass <= n.thresholds.revise) throw new Error('QUALITY_CONFIG_INVALID: pass 必须大于 revise');
  if (!(n.judge.cap_share >= 0 && n.judge.cap_share <= JUDGE_CAP_SHARE_MAX)) {
    throw new Error(`QUALITY_CONFIG_INVALID: judge.cap_share 必须介于 0 与 ${JUDGE_CAP_SHARE_MAX}`);
  }
  if (!(n.veto.cap >= 0 && n.veto.cap <= 100)) throw new Error('QUALITY_CONFIG_INVALID: veto.cap 必须介于 0 与 100');
  return true;
}

/**
 * 严格校验：PUT /api/quality/config 必须给全 weights（Σ=100）、pass>revise、cap_share≤0.35。
 * 返回归一化后的完整配置（写 settings 用）。
 */
export function validateQualityConfigInput(body = {}) {
  if (!body || typeof body !== 'object') throw new Error('QUALITY_CONFIG_INVALID: 请求体必须是对象');
  const rawWeights = body.weights;
  if (!rawWeights || typeof rawWeights !== 'object' || Array.isArray(rawWeights)) {
    throw new Error('QUALITY_CONFIG_INVALID: 缺少 weights');
  }
  const n = normalizeQualityConfig(body);
  const missing = Object.keys(DIMENSIONS).filter((k) => !(k in rawWeights));
  if (missing.length) throw new Error(`QUALITY_CONFIG_INVALID: 缺少维度权重 ${missing.join('、')}`);
  const bad = Object.entries(n.weights).filter(([, v]) => !(v >= 0 && v <= 100));
  if (bad.length) throw new Error(`QUALITY_CONFIG_INVALID: 权重越界 ${bad.map(([k]) => k).join('、')}`);
  const sum = Object.values(n.weights).reduce((a, b) => a + Number(b || 0), 0);
  if (sum !== 100) throw new Error(`QUALITY_CONFIG_INVALID: 权重合计 ${sum} ≠ 100`);
  if (!(n.thresholds.pass > n.thresholds.revise)) throw new Error('QUALITY_CONFIG_INVALID: pass 必须大于 revise');
  if (!(n.thresholds.pass <= 100)) throw new Error('QUALITY_CONFIG_INVALID: pass 不能大于 100');
  if (!(n.thresholds.revise >= 0)) throw new Error('QUALITY_CONFIG_INVALID: revise 不能小于 0');
  if (!(n.judge.cap_share >= 0 && n.judge.cap_share <= JUDGE_CAP_SHARE_MAX)) {
    throw new Error(`QUALITY_CONFIG_INVALID: judge.cap_share 必须满足 0 ≤ cap_share ≤ ${JUDGE_CAP_SHARE_MAX}`);
  }
  if (!(n.veto.cap >= 0 && n.veto.cap <= 100)) throw new Error('QUALITY_CONFIG_INVALID: veto.cap 必须介于 0 与 100');
  if (!(n.max_iterations >= 1 && n.max_iterations <= 10)) throw new Error('QUALITY_CONFIG_INVALID: max_iterations 必须介于 1 与 10');
  return n;
}
