// 极简 .docx 生成器：OOXML + ZIP(store) + CRC32，零依赖，可被 Word/WPS 正常打开。
// 原仓库用 docx 库 + 82KB 的 docxBuilder 做版式；这里按市场部需要"真能打开的 Word"重写：
//  · 支持 # / ## / ### 标题、段落、- 列表、| 管道表格（响应偏离表/自查表要能看）；
//  · 支持 <!-- pagebreak --> 分页标记，HTML 注释整行忽略；
//  · 支持 meta.layout 版式覆盖（字体/字号/行距/页边距/页码），用于对齐招标文件的格式要求；
//  · 标题层级自动防跳级（H1 后直接 H3 会落成 H2，Word 里目录/编号不会错乱）；
//  · 保持 markdownToDocx / writeDocx 两个既有导出签名，engine 的 doc Agent 无需改动。
import fs from 'node:fs';
import path from 'node:path';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBuf, end]);
}

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function paragraph(text, style, layout = {}) {
  const lineSpacing = layout.line
    ? `<w:spacing w:line="${layout.line}" w:lineRule="${layout.lineRule || 'auto'}"/>`
    : '';
  const pPr = style || lineSpacing
    ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${lineSpacing}</w:pPr>`
    : '';
  // 行内 **加粗** → 多个 run；其余按普通文本
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  const runs = parts.map((part) => {
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      return `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(part.slice(2, -2))}</w:t></w:r>`;
    }
    return `<w:r><w:t xml:space="preserve">${esc(part)}</w:t></w:r>`;
  }).join('');
  return `<w:p>${pPr}${runs}</w:p>`;
}

function pageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

/**
 * 目录页：写入真正的 TOC 域（TOC \o "1-3" \h \z \u）。
 * 页码由 Word 自己计算，打开文档时靠 settings.xml 的 updateFields 提示更新；
 * 未更新前显示占位提示，避免出现一句假的页码。
 */
function tableOfContents() {
  return '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="240"/></w:pPr>'
    + '<w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>目　录</w:t></w:r></w:p>'
    + '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>'
    + '<w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h \\z \\u </w:instrText></w:r>'
    + '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
    + '<w:r><w:t>（在 Word/WPS 中按 Ctrl+A 再按 F9 即可生成目录页码）</w:t></w:r>'
    + '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    + pageBreak();
}

/** 管道表格 → w:tbl（首行加粗 + 跨页重复表头，四周边框，等宽列） */
function tableXml(rows) {
  const cols = Math.max(...rows.map((r) => r.length), 1);
  const width = Math.floor(9200 / cols);
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`;
  const rowsXml = rows.map((row, rowIndex) => {
    const cells = [];
    // 首行作为表头：加粗 + tblHeader（长表格跨页时 Word 会自动重复表头行）
    const isHeader = rowIndex === 0;
    const bold = isHeader ? '<w:rPr><w:b/></w:rPr>' : '';
    const trPr = isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
    for (let i = 0; i < cols; i += 1) {
      const value = row[i] ?? '';
      cells.push(`<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>`
        + `<w:tcBorders>${border('top')}${border('left')}${border('bottom')}${border('right')}</w:tcBorders>`
        + `<w:vAlign w:val="center"/></w:tcPr>`
        + `<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>`
        + `<w:r>${bold}<w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p></w:tc>`);
    }
    return `<w:tr>${trPr}${cells.join('')}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>`
    + `<w:tblLayout w:type="fixed"/></w:tblPr>${rowsXml}</w:tbl>`;
}

function splitRow(line) {
  return String(line)
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableSeparator(line) {
  return /^\|?[\s:-]*-{3,}[\s:|-]*\|?$/.test(String(line).trim()) && String(line).includes('-');
}

/** 默认版式：投标文件惯例（正文小四、页脚页码、带目录页），招标文件另有规定时由 layout 覆盖 */
const DEFAULT_LAYOUT = {
  bodyFont: '宋体',
  bodyFontAscii: 'Calibri',
  bodySize: 24,
  margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
  pageNumber: true,
  toc: true,
};

/** 合并调用方传入的版式，缺项回落默认 */
export function resolveLayout(layout) {
  const merged = { ...DEFAULT_LAYOUT, ...(layout || {}) };
  merged.margins = { ...DEFAULT_LAYOUT.margins, ...((layout && layout.margins) || {}) };
  for (const key of ['top', 'right', 'bottom', 'left']) {
    if (!Number.isFinite(Number(merged.margins[key]))) merged.margins[key] = DEFAULT_LAYOUT.margins[key];
    else merged.margins[key] = Math.round(Number(merged.margins[key]));
  }
  if (!merged.bodyFont) merged.bodyFont = DEFAULT_LAYOUT.bodyFont;
  if (!Number.isFinite(Number(merged.bodySize)) || Number(merged.bodySize) <= 0) merged.bodySize = DEFAULT_LAYOUT.bodySize;
  return merged;
}

/**
 * 生成 docx 的各部件（XML 字符串），供审计与打包复用。
 * 导出 buildDocxParts 是为了让文档规范审计能直接读 XML，不必反解 zip。
 */
export function buildDocxParts(markdown, meta = {}) {
  const layout = resolveLayout(meta.layout);
  const body = [];
  const lines = String(markdown || '').split('\n');

  // 标题层级防跳级：记录上一个已用的层级，出现跳跃时压到「上一级 + 1」
  let lastLevel = 0;
  let titleDone = false;
  const headings = [];

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;
    if (/^<!--/.test(line)) {
      if (/pagebreak/i.test(line)) body.push(pageBreak());
      continue;
    }

    // 表格块：当前行以 | 开头，且下一行是分隔行
    if (/^\|/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const rows = [splitRow(line)];
      let cursor = i + 2;
      while (cursor < lines.length && /^\|/.test(lines[cursor].trim())) {
        rows.push(splitRow(lines[cursor]));
        cursor += 1;
      }
      body.push(tableXml(rows));
      i = cursor - 1;
      continue;
    }

    // 标题：# / ## / ### / #### 都转成对应级别，避免 Markdown 井号出现在 Word 里
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line);
    if (headingMatch) {
      // 文档最前面的那个 H1 是封面标题（项目名），用 DocTitle 样式：照排但不进目录、不占标题层级
      if (!titleDone && headings.length === 0 && headingMatch[1].length === 1) {
        titleDone = true;
        body.push(paragraph(headingMatch[2], 'DocTitle', { line: layout.line, lineRule: layout.lineRule }));
        continue;
      }
      let level = headingMatch[1].length;
      if (lastLevel && level > lastLevel + 1) level = lastLevel + 1;
      lastLevel = level;
      const style = level <= 1 ? 'Heading1' : level === 2 ? 'Heading2' : level === 3 ? 'Heading3' : 'Heading4';
      headings.push({ level, text: headingMatch[2] });
      body.push(paragraph(headingMatch[2], style, { line: layout.line, lineRule: layout.lineRule }));
      continue;
    }
    if (/^[-*]\s+/.test(line)) body.push(paragraph(`• ${line.replace(/^[-*]\s+/, '')}`, null, layout));
    else body.push(paragraph(line, null, layout));
  }

  const m = layout.margins;
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${layout.toc ? tableOfContents() : ''}${body.join('')}
<w:sectPr>${layout.pageNumber ? '<w:footerReference w:type="default" r:id="rIdFooter1"/>' : ''}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="${m.top}" w:right="${m.right}" w:bottom="${m.bottom}" w:left="${m.left}"/></w:sectPr>
</w:body></w:document>`;

  // 目录条目的制表位放在右页边距处，点线与页码才对得齐
  const rightTab = 11906 - layout.margins.left - layout.margins.right;
  const tocStyle = (id, level, indent) => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="toc ${level}"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${rightTab}"/></w:tabs><w:spacing w:before="40" w:after="40"/>${indent ? `<w:ind w:left="${indent}"/>` : ''}</w:pPr><w:rPr><w:sz w:val="24"/>${level === 1 ? '<w:b/>' : ''}<w:rFonts w:eastAsia="${esc(layout.bodyFont)}"/></w:rPr></w:style>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${esc(layout.bodyFontAscii)}" w:eastAsia="${esc(layout.bodyFont)}"/><w:sz w:val="${layout.bodySize}"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:rFonts w:eastAsia="${esc(layout.bodyFont)}"/><w:sz w:val="${layout.bodySize}"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="DocTitle"><w:name w:val="Doc Title"/><w:basedOn w:val="Normal"/><w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="360"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:rFonts w:eastAsia="黑体"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="360" w:after="200"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:rFonts w:eastAsia="黑体"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="280" w:after="160"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:rFonts w:eastAsia="黑体"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="22"/><w:rFonts w:eastAsia="黑体"/></w:rPr></w:style>
${tocStyle('TOC1', 1, 0)}
${tocStyle('TOC2', 2, 420)}
${tocStyle('TOC3', 3, 840)}
</w:styles>`;

  // 页码：页脚居中 PAGE 域。作者/修改人等元数据不写公司名，避免投标文件里带出编写方信息。
  const footer = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:p><w:pPr><w:jc w:val="center"/></w:pPr>
<w:r><w:fldChar w:fldCharType="begin"/></w:r>
<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>
<w:r><w:fldChar w:fldCharType="separate"/></w:r>
<w:r><w:t>1</w:t></w:r>
<w:r><w:fldChar w:fldCharType="end"/></w:r>
</w:p></w:ftr>`;

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
<dc:title>${esc(meta.title || '投标文件')}</dc:title>
<dc:creator>${esc(meta.author || '')}</dc:creator>
<cp:keywords>${esc(meta.keywords || '')}</cp:keywords>
<dcterms:created xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`;

  // settings：只有带目录页时才需要 updateFields（Word 打开会提示"是否更新域"，点"是"目录页码自动生成）
  const settings = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:updateFields w:val="true"/>
<w:defaultTabStop w:val="420"/>
</w:settings>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
${layout.pageNumber ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : ''}
${layout.toc ? '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>' : ''}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
${layout.pageNumber ? '<Relationship Id="rIdFooter1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : ''}
${layout.toc ? '<Relationship Id="rIdSettings" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>' : ''}
</Relationships>`;

  return { document, styles, core, footer, settings, contentTypes, rels, docRels, layout, headings, bodyCount: body.length };
}

/** markdown（标题/段落/列表/表格）→ docx Buffer */
export function markdownToDocx(markdown, meta = {}) {
  const parts = buildDocxParts(markdown, meta);
  const entries = [
    { name: '[Content_Types].xml', data: parts.contentTypes },
    { name: '_rels/.rels', data: parts.rels },
    { name: 'word/document.xml', data: parts.document },
    { name: 'word/styles.xml', data: parts.styles },
    { name: 'word/_rels/document.xml.rels', data: parts.docRels },
    { name: 'docProps/core.xml', data: parts.core },
  ];
  if (parts.layout.pageNumber) entries.push({ name: 'word/footer1.xml', data: parts.footer });
  if (parts.layout.toc) entries.push({ name: 'word/settings.xml', data: parts.settings });
  return zipStore(entries);
}

export function writeDocx(filePath, markdown, meta) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buf = markdownToDocx(markdown, meta);
  fs.writeFileSync(filePath, buf);
  return { filePath, size: buf.length };
}
