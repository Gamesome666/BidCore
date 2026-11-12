// 极简 .docx 生成器：OOXML + ZIP(store) + CRC32，零依赖，可被 Word/WPS 正常打开。
// 原仓库用 docx 库 + 82KB 的 docxBuilder 做版式；这里按市场部需要"真能打开的 Word"重写：
//  · 支持 # / ## / ### 标题、段落、- 列表、| 管道表格（响应偏离表/自查表要能看）；
//  · 支持 <!-- pagebreak --> 分页标记，HTML 注释整行忽略；
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

function paragraph(text, style) {
  const pPr = style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : '';
  return `<w:p>${pPr}<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function pageBreak() {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}

/** 管道表格 → w:tbl（首行加粗，四周边框，等宽列） */
function tableXml(rows) {
  const cols = Math.max(...rows.map((r) => r.length), 1);
  const width = Math.floor(9200 / cols);
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`;
  const rowsXml = rows.map((row, rowIndex) => {
    const cells = [];
    for (let i = 0; i < cols; i += 1) {
      const value = row[i] ?? '';
      const bold = rowIndex === 0 ? '<w:rPr><w:b/></w:rPr>' : '';
      cells.push(`<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>`
        + `<w:tcBorders>${border('top')}${border('left')}${border('bottom')}${border('right')}</w:tcBorders>`
        + `<w:vAlign w:val="center"/></w:tcPr>`
        + `<w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>`
        + `<w:r>${bold}<w:t xml:space="preserve">${esc(value)}</w:t></w:r></w:p></w:tc>`);
    }
    return `<w:tr>${cells.join('')}</w:tr>`;
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

/** markdown（标题/段落/列表/表格）→ docx Buffer */
export function markdownToDocx(markdown, meta = {}) {
  const body = [];
  const lines = String(markdown || '').split('\n');

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

    if (line.startsWith('### ')) body.push(paragraph(line.slice(4), 'Heading3'));
    else if (line.startsWith('## ')) body.push(paragraph(line.slice(3), 'Heading2'));
    else if (line.startsWith('# ')) body.push(paragraph(line.slice(2), 'Heading1'));
    else if (/^[-*]\s+/.test(line)) body.push(paragraph(`• ${line.replace(/^[-*]\s+/, '')}`));
    else body.push(paragraph(line));
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body.join('')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
</w:body></w:document>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:eastAsia="宋体"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="360" w:after="200"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:rFonts w:eastAsia="黑体"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="280" w:after="160"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:rFonts w:eastAsia="黑体"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
</w:styles>`;

  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
<dc:title>${esc(meta.title || '投标文件')}</dc:title>
<dc:creator>${esc(meta.author || 'BidCore')}</dc:creator>
<cp:keywords>${esc(meta.keywords || 'bid,agent,workflow')}</cp:keywords>
<dcterms:created xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
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
</Relationships>`;

  return zipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    { name: 'docProps/core.xml', data: core },
  ]);
}

export function writeDocx(filePath, markdown, meta) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const buf = markdownToDocx(markdown, meta);
  fs.writeFileSync(filePath, buf);
  return { filePath, size: buf.length };
}
