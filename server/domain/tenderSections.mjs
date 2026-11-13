// 招标文件版面识别：不依赖固定章号，按标题语义找「投标文件格式」「资格审查」等章节。
// 适合不同版本的招标文件（第七章/第六章、3.1/3.2、纯标题无编号都能吃）。
import { clip } from '../lib/util.mjs';

const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const CHAPTER_RE = /^第[一二三四五六七八九十百零〇\d]+章[\s、.．:：-]*/;

/**
 * 按 Markdown 标题与「第X章」行切分章节。
 * @returns {Array<{title:string, level:number, lines:string[], index:number}>}
 */
export function splitSections(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sections = [];
  let current = { title: '（开头）', level: 0, lines: [], index: 0 };
  const flush = () => {
    if (current.title !== '（开头）' || current.lines.some((line) => line.trim())) sections.push(current);
  };
  lines.forEach((raw, index) => {
    const line = raw.trim();
    const heading = HEADING_RE.exec(line);
    const isChapter = !heading && CHAPTER_RE.test(line) && line.length <= 60;
    if (heading || isChapter) {
      flush();
      current = {
        title: heading ? heading[2].trim() : line,
        level: heading ? heading[1].length : 1,
        lines: [],
        index,
      };
      return;
    }
    current.lines.push(raw);
  });
  flush();
  return sections;
}

/** 行内表格：`a | b | c` 或制表符分隔 */
export function tableRows(lines) {
  const rows = [];
  for (const raw of lines) {
    const line = String(raw).trim();
    if (!line) continue;
    const cells = line.includes('|')
      ? line.split('|').map((cell) => cell.trim())
      : line.includes('\t') ? line.split('\t').map((cell) => cell.trim()) : null;
    if (!cells) continue;
    const filled = cells.filter(Boolean);
    if (filled.length >= 2) rows.push(filled);
  }
  return rows;
}

/** 从若干「1、2、3…」行里取最长的一段连续编号（多张表拼接时避免串表） */
export function longestNumberedRun(rows) {
  const runs = [];
  let current = [];
  for (const row of rows) {
    if (!/^\d{1,2}$/.test(row[0] || '')) continue;
    const no = Number(row[0]);
    if (no === 1 && current.length) { runs.push(current); current = []; }
    current.push({ no, content: row[1] || '', note: row[2] || '' });
  }
  if (current.length) runs.push(current);
  return (runs.sort((a, b) => b.length - a.length)[0] || []).map((row, index) => ({
    no: index + 1, content: row.content, note: row.note,
  }));
}

function scoreSection(section, patterns) {
  let score = 0;
  for (const re of patterns) if (re.test(section.title)) score += 3;
  if (!score) return 0;
  const rows = tableRows(section.lines).length;
  return score + Math.min(3, rows / 4) + Math.min(1, String(section.lines.join('')).length / 4000);
}

/** 按标题语义找章节：标题命中优先，其次表格更多、正文更长的那节 */
export function findSection(sections, patterns) {
  let best = null;
  for (const section of sections) {
    // 先并入子章节再打分：资格条款常写在 3.1/3.2 这类子节里
    const full = withSubsections(sections, section);
    const score = scoreSection(full, patterns);
    if (!score) continue;
    if (!best || score > best.score) best = { section, score };
  }
  return best ? best.section : null;
}

/** 取某章节的直接子章节（层级比它深的连续段） */
export function childSections(sections, section) {
  const index = sections.indexOf(section);
  if (index < 0) return [];
  const children = [];
  for (let i = index + 1; i < sections.length; i += 1) {
    if (sections[i].level <= section.level) break;
    children.push(sections[i]);
  }
  return children;
}

/**
 * 把子章节的正文并进来：招标文件常是「第三章 资格审查」下再分 3.1 / 3.2，
 * 只取父章节自身那几行会漏掉真正的条款表格。
 */
export function withSubsections(sections, section) {
  const index = sections.indexOf(section);
  if (index < 0) return section;
  const lines = [...section.lines];
  for (let i = index + 1; i < sections.length; i += 1) {
    const next = sections[i];
    if (next.level <= section.level && section.level > 0) break;
    lines.push(...next.lines);
  }
  return { ...section, lines };
}

const FORMAT_PATTERNS = [
  /投标文件.{0,8}(格式|组成|编制|目录|顺序|内容)/,
  /投标文件的?(格式|组成|编制)/,
  /投标文件格式/,
  /响应文件.{0,6}(格式|组成|编制)/,
];

const QUAL_PATTERNS = [
  /资格(审查|要求|条件)/,
  /投标人资格/,
  /合格的?投标人/,
  /供应商资格/,
];

/**
 * 提取「投标文件格式」清单（第几章都行）。
 * @returns {{items:Array<{no:number,content:string,note:string}>, forms:Array<{no:string,name:string}>, sectionTitle:string, source:'section'|'fallback'}}
 */
export function extractBidFormat(text) {
  const source = String(text || '');
  const sections = splitSections(source);

  // 先按标题语义圈定候选章节（含子章节），谁解析出的「组成清单」最长就选谁；
  // 这样「第五章 投标文件的组成」和其中的「7.2 投标文件格式」不会打架。
  const candidates = sections
    .filter((section) => FORMAT_PATTERNS.some((re) => re.test(section.title)))
    .map((section) => {
      const full = withSubsections(sections, section);
      return { section, items: longestNumberedRun(tableRows(full.lines)) };
    })
    .filter((candidate) => candidate.items.length >= 5 && candidate.items.length <= 24)
    .sort((a, b) => b.items.length - a.items.length || a.section.level - b.section.level);

  let items = [];
  let usedSection = null;
  if (candidates.length) {
    items = candidates[0].items;
    usedSection = candidates[0].section;
  } else {
    // 没有明显标题时：全文找「从 1 开始、5–20 项」的表格
    const fallback = sections
      .map((section) => ({ section, items: longestNumberedRun(tableRows(withSubsections(sections, section).lines)) }))
      .filter((candidate) => candidate.items.length >= 5 && candidate.items.length <= 20)
      .sort((a, b) => b.items.length - a.items.length || a.section.level - b.section.level);
    if (fallback.length) {
      items = fallback[0].items;
      usedSection = fallback[0].section;
    }
  }

  const forms = [];
  for (const match of source.matchAll(/格式\s*([一二三四五六七八九十]+|\d+\s*-\s*\d+)\s*([^\n|]{2,24})/g)) {
    const name = match[2].trim();
    // 过滤「格式要求」「格式：」这类说明文字，只留真正的表单标题
    if (name.length > 22 || /[：:]|要求|说明|见附件/.test(name)) continue;
    forms.push({ no: match[1].replace(/\s+/g, ''), name });
  }
  // 同一张表可能同时出现「格式一 投标函」和「格式 7-1 投标函」，按名称合并、优先保留 7-1 这种编号
  const byName = new Map();
  for (const form of forms) {
    const key = form.name.replace(/[（(].*$/, '').replace(/\s+/g, '');
    const existing = byName.get(key);
    if (!existing || (/^\d/.test(form.no) && !/^\d/.test(existing.no))) byName.set(key, form);
  }
  const uniqueForms = [...byName.values()].slice(0, 12);

  return {
    items,
    forms: uniqueForms,
    sectionTitle: usedSection?.title || '',
    source: usedSection ? 'section' : (items.length ? 'fallback' : 'none'),
  };
}

/**
 * 提取资格审查条款：不依赖 3.1/3.2 编号。
 * 表格按列判断（有证明材料列 / ★ → 特定资格），行内编号按层级判断。
 * @returns {{general:Array, specific:Array, sectionTitle:string}}
 */
export function extractQualificationClauses(text) {
  const source = String(text || '');
  const sections = splitSections(source);
  const parent = findSection(sections, QUAL_PATTERNS);

  // 只取「一般资格 / 特定资格 / 资格要求」这类子节，避开 3.3 材料清单、3.4 核查方式
  let scope = [];
  if (parent) {
    const children = childSections(sections, parent);
    const targeted = children.filter((section) => /(一般|特定|基本|其他)?资格/.test(section.title)
      && !/清单|材料|核查|方式|证明/.test(section.title));
    scope = (targeted.length ? targeted : [withSubsections(sections, parent)])
      .flatMap((section) => section.lines);
  } else {
    scope = source.split(/\r?\n/);
  }

  const general = [];
  const specific = [];
  const seen = new Set();
  const pushRow = (clause, requirement, evidence = '', attribute = '') => {
    const req = String(requirement || '').trim();
    if (!req || req.length < 4) return;
    if (/^(要求|内容|证明材料|备注|说明)$/.test(req)) return;
    const key = `${clause}|${clip(req, 30)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const item = { clause: String(clause || '').trim(), requirement: req, evidence, attribute };
    // 「特定资格」看有无证明材料列 / ★ 实质性标记；编号层级不作为判据（一般资格也是 3.1.1 这种）
    if (evidence || /★|实质性/.test(`${attribute}${req}`)) specific.push(item);
    else general.push(item);
  };

  // 表格型条款（含证明材料列）
  for (const cells of tableRows(scope)) {
    const first = cells[0] || '';
    if (/^\d+(\.\d+){0,3}$/.test(first) || /^\d{1,2}$/.test(first)) {
      pushRow(first, cells[1], cells[2] || '', cells[3] || '');
    }
  }

  // 行内编号型条款（3.1.1 xxx / 1. xxx），与表格并行解析，pushRow 会去重
  for (const raw of scope) {
    const line = String(raw).trim();
    if (!line) continue;
    if (line.includes('\t') || line.includes('|')) continue; // 表格行已在上面按列处理
    const match = /^(\d+(?:\.\d+){0,3})[.、．)）]?\s+(.{4,})$/.exec(line);
    if (!match) continue;
    const clause = match[1];
    const requirement = match[2].trim();
    if (/^\d+\.\d+\.\d+/.test(clause) || /★/.test(requirement)) pushRow(clause, requirement);
    else general.push({ clause, requirement, evidence: '', attribute: '' });
  }

  return { general, specific, sectionTitle: parent?.title || '' };
}
