// Word / Excel 里 XML 的通用清洗：实体解码 + 标签剥离。零依赖。

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', mdash: '—', ndash: '–',
  hellip: '…', middot: '·', bull: '•', times: '×', divide: '÷', copy: '©', reg: '®', trade: '™',
};

/** XML/HTML 实体 → 字符（含 &#xNNNN; / &#NNN;） */
export function decodeEntities(input) {
  return String(input || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try { return String.fromCodePoint(code); } catch { return match; }
    }
    return ENTITIES[body] ?? match;
  });
}

/** 去掉全部标签，保留文字（用于 <w:t> 之外的兜底） */
export function stripTags(input) {
  return decodeEntities(String(input || '').replace(/<[^>]*>/g, ''));
}

/** 段落内的软换行/制表符归一 + 空白压缩 */
export function tidyText(input) {
  return String(input || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

/** 按 UTF-8 解码，失败/乱码时回退 GBK（Windows 中文资料常见） */
export function decodeTextBuffer(buf) {
  if (!buf?.length) return '';
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  const utf8 = buf.toString('utf8');
  const bad = (utf8.match(/\uFFFD/g) || []).length;
  if (bad === 0) return utf8;
  try {
    const gbk = new TextDecoder('gbk', { fatal: false }).decode(buf);
    return (gbk.match(/\uFFFD/g) || []).length < bad ? gbk : utf8;
  } catch {
    return utf8;
  }
}
