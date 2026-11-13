// DOCX → 纯文本：直接读 OOXML 里的 word/document.xml，按段落/表格还原可读结构。零依赖。
// 支持：段落、标题层级（Heading1-9 / w:outlineLvl）、表格（行内用 | 分隔）、制表符与软换行。
// 不支持：文本框、页眉页脚、批注、SmartArt（这些不进正文，投标资料很少依赖）。
import { readZip } from '../zip.mjs';
import { decodeEntities, tidyText } from './xml.mjs';

const TABLE_RE = /<w:tbl>[\s\S]*?<\/w:tbl>/g;
const PARAGRAPH_RE = /<w:p\b[^>]*>[\s\S]*?<\/w:p>|<w:p\b[^>]*\/>/g;
const ROW_RE = /<w:tr\b[^>]*>[\s\S]*?<\/w:tr>/g;
const CELL_RE = /<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g;
const TEXT_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;

/** 段落里的文字：<w:t> 内容 + 制表符/软换行 */
function paragraphText(xml) {
  return decodeEntities(
    String(xml)
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/g, '\n')
      .replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (_, text) => text)
      .replace(/<[^>]*>/g, ''),
  ).replace(/\n{3,}/g, '\n\n');
}

/** 标题层级：Heading1-9 / 中英文样式名 / w:outlineLvl */
function headingLevel(xml) {
  const style = /<w:pStyle\b[^>]*w:val="([^"]*)"/.exec(xml)?.[1] || '';
  const outline = /<w:outlineLvl\b[^>]*w:val="(\d+)"/.exec(xml)?.[1];
  const named = /^(?:heading|标题)\s*([1-9])$/i.exec(style);
  if (named) return Number(named[1]);
  if (/^[1-9]$/.test(style)) return Number(style);
  if (outline !== undefined) return Math.min(9, Number(outline) + 1);
  return 0;
}

function renderTable(xml) {
  const rows = String(xml).match(ROW_RE) || [];
  return rows
    .map((row) => (row.match(CELL_RE) || [])
      .map((cell) => (cell.match(PARAGRAPH_RE) || [])
        .map((p) => paragraphText(p).replace(/\s*\n\s*/g, ' ').trim())
        .filter(Boolean)
        .join(' '))
      .join(' | '))
    .filter((line) => line.replace(/[\s|]/g, ''))
    .join('\n');
}

/**
 * @param {Buffer} buf docx 文件
 * @returns {{text: string, blocks: number}}
 */
export function parseDocx(buf) {
  const entries = readZip(buf);
  const main = entries.get('word/document.xml');
  if (!main) throw new Error('docx 缺少 word/document.xml');
  const xml = main.toString('utf8');

  // 表格与段落按出现顺序处理：先把表格整体替换成占位符，再统一按块拼接
  const blocks = [];
  const tables = [];
  const masked = xml.replace(TABLE_RE, (table) => {
    tables.push(renderTable(table));
    return `\u0000TBL${tables.length - 1}\u0000`;
  });

  // OOXML 里表格和段落是兄弟节点：必须按文档顺序一起扫描，
  // 否则表格占位符落在两个 <w:p> 之间会被漏掉（只保留表格前的段落）。
  const NUL = String.fromCharCode(0);
  const BLOCK_RE = new RegExp(`${PARAGRAPH_RE.source}|${NUL}TBL([0-9]+)${NUL}`, 'g');
  const parts = [];
  for (const match of masked.matchAll(BLOCK_RE)) {
    if (match[1] !== undefined) {
      const table = tables[Number(match[1])];
      if (table) parts.push(table);
      continue;
    }
    const chunk = match[0];
    const text = paragraphText(chunk).trim();
    if (!text) continue;
    const level = headingLevel(chunk);
    parts.push(level ? `${'#'.repeat(level)} ${text}` : text);
  }
  // 段落正则没覆盖到的表格（例如整段藏在 w:sdt 里）兜底补上
  if (!parts.length) for (const table of tables) if (table) parts.push(table);

  blocks.length = 0;
  const text = tidyText(parts.join('\n\n'));
  return { text, blocks: parts.length };
}
