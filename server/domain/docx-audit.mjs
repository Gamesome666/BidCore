// 文档规范审计：对「即将导出的那份 docx」做结构与版式自检，接进质量门禁的 documentation 维度。
// 参考 OpenBidKit 的 C# 规则引擎（FontRules/ParagraphRules/TableRules/StructureRules 的思路），
// 但只用纯 JS 扫自家生成的 XML —— 不引入 .NET 运行时，保持零依赖。
// 只检查"生成器自己能修好"的项，避免出现永远修不好的死循环：
//   标题跳级 / 字体字号 / 页边距 / 页码 / 表格表头 / 元数据泄露。
import { buildDocxParts, resolveLayout } from './docx.mjs';

const LABELS = {
  'AUD-01': '标题层级不跳级',
  'AUD-02': '正文字体字号合规',
  'AUD-03': '页边距合规',
  'AUD-04': '页码存在',
  'AUD-05': '表格表头规范',
  'AUD-06': '元数据不泄露编写方',
  'AUD-07': '目录页存在',
};

function item(rule, score, message, evidence = []) {
  return {
    rule, label: LABELS[rule],
    score: Math.max(0, Math.min(100, Math.round(score))),
    message, evidence,
  };
}

/** 标题层级：H1 之后不能直接 H3（Word 目录/多级编号会错乱） */
function auditHeadings(headings) {
  const jumps = [];
  let prev = 0;
  for (const h of headings) {
    if (prev && h.level > prev + 1) jumps.push({ level: h.level, prev, text: String(h.text || '').slice(0, 30) });
    prev = h.level;
  }
  if (!headings.length) return item('AUD-01', 100, '无标题层级，跳过跳级检查');
  return item('AUD-01', jumps.length ? 100 - Math.min(100, jumps.length * 20) : 100,
    jumps.length ? `标题层级跳级 ${jumps.length} 处（如 H${jumps[0].prev} 直接到 H${jumps[0].level}）` : `标题层级连续，共 ${headings.length} 级标题`,
    jumps.slice(0, 4).map((j) => ({ type: 'heading', ref: `H${j.level}`, excerpt: j.text })));
}

/** 字体字号：要与招标文件要求的版式一致 */
function auditFont(actual, expected) {
  if (!expected || (!expected.bodyFont && !expected.bodySize)) {
    return item('AUD-02', 100, '招标文件未规定字体字号，按默认版式');
  }
  const problems = [];
  if (expected.bodyFont && expected.bodyFont !== actual.bodyFont) problems.push(`字体应为「${expected.bodyFont}」，实际「${actual.bodyFont}」`);
  if (expected.bodySize && Number(expected.bodySize) !== Number(actual.bodySize)) {
    problems.push(`字号应为 ${expected.bodySize / 2}pt，实际 ${actual.bodySize / 2}pt`);
  }
  return item('AUD-02', problems.length ? 60 : 100,
    problems.length ? problems.join('；') : `字体「${actual.bodyFont}」${actual.bodySize / 2}pt，符合招标要求`,
    problems.map((p) => ({ type: 'format', ref: 'font', excerpt: p })));
}

/** 页边距：逐边比对（招标只规定部分边时，只比规定的那几边） */
function auditMargins(actual, expected) {
  if (!expected || !expected.margins || !Object.keys(expected.margins).length) {
    return item('AUD-03', 100, '招标文件未规定页边距，按默认 2.54cm');
  }
  const keys = ['top', 'right', 'bottom', 'left'];
  const bad = [];
  for (const key of keys) {
    const want = Number(expected.margins[key]);
    if (!Number.isFinite(want)) continue;
    const got = Number(actual.margins[key]);
    if (Math.abs(want - got) > 60) bad.push(`${key} 应为 ${(want / 566.93).toFixed(2)}cm，实际 ${(got / 566.93).toFixed(2)}cm`);
  }
  const checked = keys.filter((k) => Number.isFinite(Number(expected.margins[k]))).length;
  const score = checked ? 100 - (bad.length / checked) * 100 : 100;
  return item('AUD-03', score,
    bad.length ? `页边距不符 ${bad.length} 处：${bad[0]}` : '页边距符合招标要求',
    bad.map((b) => ({ type: 'margin', ref: 'margins', excerpt: b })));
}

/** 页码：投标文件一律要有页脚页码（PAGE 域），缺失就没法装订翻页 */
function auditPageNumber(actual) {
  const wants = actual.pageNumber;
  return item('AUD-04', wants ? 100 : 40,
    wants ? '页脚已插入 PAGE 页码域' : '导出文件没有页脚页码',
    wants ? [] : [{ type: 'footer', ref: 'page', excerpt: '缺少 PAGE 域' }]);
}

/** 表格表头：每个表格首行都要有 tblHeader（跨页才会重复表头） */
function auditTables(documentXml) {
  const tables = (documentXml.match(/<w:tbl>/g) || []).length;
  if (!tables) return item('AUD-05', 100, '文档无表格');
  const headers = (documentXml.match(/<w:tblHeader\/>/g) || []).length;
  const missing = Math.max(0, tables - headers);
  return item('AUD-05', tables ? 100 - (missing / tables) * 30 : 100,
    missing ? `${missing}/${tables} 个表格缺少跨页重复表头` : `${tables} 个表格均有跨页重复表头`,
    missing ? [{ type: 'table', ref: 'tblHeader', excerpt: '首行未标记表头' }] : []);
}

/** 元数据：不能把编写工具名/内部代号写进投标文件属性里 */
function auditMetadata(coreXml) {
  const creator = (/<dc:creator>([^<]*)</.exec(coreXml) || [])[1] || '';
  const leaks = /bidcore|gamesome|openbidkit|claude|gpt|agent/i.test(creator);
  return item('AUD-06', leaks ? 0 : 100,
    leaks ? `文档属性作者含编写方标识「${creator}」` : (creator ? `文档属性作者「${creator}」，无编写方标识` : '文档属性未写编写方'),
    leaks ? [{ type: 'metadata', ref: 'dc:creator', excerpt: creator }] : []);
}

/** 目录：投标文件要有目录页，且必须是可更新的 TOC 域而不是手写死的页码 */
function auditToc(documentXml) {
  const hasToc = /<w:instrText[^>]*>\s*TOC\s/.test(documentXml);
  return item('AUD-07', hasToc ? 100 : 40,
    hasToc ? '已写入 TOC 目录域，打开文档按 F9 即生成页码' : '文档没有目录页（投标文件通常要求目录）',
    hasToc ? [] : [{ type: 'toc', ref: 'TOC', excerpt: '缺少 TOC 域' }]);
}

/**
 * 审计一份待导出的文档。
 * @param {object} input
 * @param {string} input.markdown 即将导出的正文（与真正导出用的是同一份）
 * @param {object} [input.meta] 传给生成器的元信息（title/author）
 * @param {object} [input.expected] 招标文件规定的版式（layout.mjs 解析结果）
 * @returns {{score:number, verdict:string, message:string, evidence:object[], items:object[]}}
 */
export function auditDocument({ markdown, meta = {}, expected = null } = {}) {
  const parts = buildDocxParts(markdown, { ...meta, layout: expected });
  const actual = resolveLayout(expected);

  const items = [
    auditHeadings(parts.headings || []),
    auditFont(actual, expected),
    auditMargins(actual, expected),
    auditPageNumber(actual),
    auditTables(parts.document),
    auditMetadata(parts.core),
    auditToc(parts.document),
  ];

  const score = Math.round(items.reduce((sum, it) => sum + it.score, 0) / items.length);
  const failed = items.filter((it) => it.score < 100);
  return {
    score,
    verdict: failed.length ? 'revise' : 'pass',
    message: failed.length
      ? `文档规范 ${failed.length} 项待修：${failed.map((f) => f.label).join('、')}`
      : '文档规范全部通过（层级/字体/边距/页码/表头/元数据）',
    evidence: failed.flatMap((f) => f.evidence).slice(0, 6),
    items,
  };
}
