// PDF → 纯文本：自写的最小 PDF 解析器（零依赖，只用 node:zlib）。
// 覆盖投标资料里最常见的三类 PDF：
//   1. Word/WPS 导出的文本层 PDF（简单字体 + ToUnicode）
//   2. 中文 PDF（Type0 / Identity-H，靠 ToUnicode CMap 映射 CID → Unicode）
//   3. 带对象流（/ObjStm）的 PDF 1.5+
// 不覆盖：加密 PDF、扫描件（无文本层）、OCR —— 这些会返回空文本，由上层标记“未识别到文本”。
import zlib from 'node:zlib';

/* ═════════════════════════════ PDF 词法 / 语法 ═════════════════════════════ */

const WS = new Set(['\u0000', '\t', '\n', '\f', '\r', ' ']);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

class Lexer {
  constructor(src, pos = 0) {
    this.src = src;
    this.pos = pos;
  }

  skip() {
    const s = this.src;
    while (this.pos < s.length) {
      const ch = s[this.pos];
      if (WS.has(ch)) { this.pos += 1; continue; }
      if (ch === '%') {
        while (this.pos < s.length && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.pos += 1;
        continue;
      }
      break;
    }
  }

  /** 读一个字面量字符串 ( ... )，返回解码后的 Buffer（保留原始字节） */
  string() {
    const s = this.src;
    this.pos += 1; // 跳过 (
    const bytes = [];
    let depth = 1;
    while (this.pos < s.length) {
      const ch = s[this.pos];
      if (ch === '\\') {
        const next = s[this.pos + 1];
        this.pos += 2;
        if (next === 'n') bytes.push(0x0a);
        else if (next === 'r') bytes.push(0x0d);
        else if (next === 't') bytes.push(0x09);
        else if (next === 'b') bytes.push(0x08);
        else if (next === 'f') bytes.push(0x0c);
        else if (next === '\n') { /* 续行 */ }
        else if (next === '\r') { if (s[this.pos] === '\n') this.pos += 1; }
        else if (next >= '0' && next <= '7') {
          let oct = next;
          for (let k = 0; k < 2 && s[this.pos] >= '0' && s[this.pos] <= '7'; k += 1) { oct += s[this.pos]; this.pos += 1; }
          bytes.push(parseInt(oct, 8) & 0xff);
        } else if (next !== undefined) bytes.push(next.charCodeAt(0) & 0xff);
        continue;
      }
      if (ch === '(') { depth += 1; bytes.push(0x28); this.pos += 1; continue; }
      if (ch === ')') {
        depth -= 1;
        this.pos += 1;
        if (depth === 0) break;
        bytes.push(0x29);
        continue;
      }
      bytes.push(ch.charCodeAt(0) & 0xff);
      this.pos += 1;
    }
    return Buffer.from(bytes);
  }

  hexString() {
    const s = this.src;
    this.pos += 1;
    let hex = '';
    while (this.pos < s.length && s[this.pos] !== '>') {
      const ch = s[this.pos];
      if (/[0-9a-fA-F]/.test(ch)) hex += ch;
      this.pos += 1;
    }
    this.pos += 1;
    if (hex.length % 2) hex += '0';
    return Buffer.from(hex, 'hex');
  }

  name() {
    const s = this.src;
    this.pos += 1;
    let name = '';
    while (this.pos < s.length && !WS.has(s[this.pos]) && !DELIM.has(s[this.pos])) {
      name += s[this.pos];
      this.pos += 1;
    }
    return name.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }

  /** 解析任意 PDF 值：dict / array / name / string / number / ref / keyword */
  value() {
    this.skip();
    const s = this.src;
    if (this.pos >= s.length) return { type: 'eof' };
    const ch = s[this.pos];
    if (ch === '<' && s[this.pos + 1] === '<') {
      this.pos += 2;
      const entries = new Map();
      for (;;) {
        this.skip();
        if (this.pos >= s.length) break;
        if (s[this.pos] === '>' && s[this.pos + 1] === '>') { this.pos += 2; break; }
        if (s[this.pos] !== '/') { this.value(); continue; }
        const key = this.name();
        if (key === '') break;
        entries.set(key, this.value());
      }
      return { type: 'dict', entries };
    }
    if (ch === '[') {
      this.pos += 1;
      const items = [];
      for (;;) {
        this.skip();
        if (this.pos >= s.length) break;
        if (s[this.pos] === ']') { this.pos += 1; break; }
        items.push(this.value());
      }
      return { type: 'array', items };
    }
    if (ch === '/') return { type: 'name', value: this.name() };
    if (ch === '(') return { type: 'string', value: this.string() };
    if (ch === '<') return { type: 'string', value: this.hexString() };
    let token = '';
    while (this.pos < s.length && !WS.has(s[this.pos]) && !DELIM.has(s[this.pos])) {
      token += s[this.pos];
      this.pos += 1;
    }
    if (token === 'true' || token === 'false') return { type: 'bool', value: token === 'true' };
    if (token === 'null') return { type: 'null' };
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) {
      // 间接引用形如 "6 0 R"：数字后面还跟着 generation 和 R 才是引用
      if (/^\d+$/.test(token)) {
        const save = this.pos;
        this.skip();
        let gen = '';
        while (this.pos < s.length && !WS.has(s[this.pos]) && !DELIM.has(s[this.pos])) {
          gen += s[this.pos];
          this.pos += 1;
        }
        if (/^\d+$/.test(gen)) {
          this.skip();
          if (s[this.pos] === 'R' && (this.pos + 1 >= s.length || WS.has(s[this.pos + 1]) || DELIM.has(s[this.pos + 1]))) {
            this.pos += 1;
            return { type: 'ref', num: Number(token) };
          }
        }
        this.pos = save;
      }
      return { type: 'number', value: Number(token) };
    }
    return { type: 'keyword', value: token };
  }
}

/* ═════════════════════════════ 对象表 ═════════════════════════════ */

function inflate(data) {
  try { return zlib.inflateSync(data); } catch { /* 退化到 raw deflate */ }
  try { return zlib.inflateRawSync(data); } catch { return null; }
}

/** 按 /Filter 解码流（只支持 Flate / 无编码，够用了） */
function decodeStream(stream, dict) {
  if (!stream) return null;
  const filter = dict?.entries?.get('Filter');
  const names = [];
  const push = (node) => {
    if (!node) return;
    if (node.type === 'name') names.push(node.value);
    else if (node.type === 'array') node.items.forEach(push);
  };
  push(filter);
  // 没有 /Filter 就是明文流，直接用（不能再 inflate，否则解不出来）
  if (!names.length) return stream;
  if (names.every((n) => n === 'FlateDecode' || n === 'Fl')) return inflate(stream);
  if (names.length === 1 && (names[0] === 'ASCIIHexDecode')) {
    return Buffer.from(stream.toString('latin1').replace(/[^0-9a-fA-F]/g, ''), 'hex');
  }
  return null;
}

/** 扫描所有 "N G obj ... endobj"，带 stream 的单独切出来 */
function scanObjects(buf) {
  const src = buf.toString('latin1');
  const objects = new Map();
  const re = /(?:^|[\s\r\n])(\d+)\s+(\d+)\s+obj\b/g;
  let match;
  while ((match = re.exec(src))) {
    const num = Number(match[1]);
    const bodyStart = match.index + match[0].length;
    const endobj = src.indexOf('endobj', bodyStart);
    const streamKeyword = /(?:^|[\r\n\s])stream[\r\n]/.exec(src.slice(bodyStart, endobj > 0 ? endobj : bodyStart + 4_000_000));
    if (streamKeyword && endobj >= 0) {
      const streamMark = bodyStart + streamKeyword.index + streamKeyword[0].indexOf('stream');
      let dataStart = streamMark + 'stream'.length;
      // 规范是 stream 后跟单个 EOL；实际文件常见 \r\n / \n\r，统一吃掉连续换行
      while (dataStart < src.length && (src[dataStart] === '\r' || src[dataStart] === '\n')) dataStart += 1;
      const declared = /\/Length\s+(\d+)/.exec(src.slice(bodyStart, streamMark));
      let dataEnd = declared ? dataStart + Number(declared[1]) : -1;
      const tail = dataEnd > 0 ? src.slice(dataEnd, dataEnd + 24) : '';
      if (!declared || !/^\s*endstream/.test(tail)) {
        const idx = src.indexOf('endstream', dataStart);
        dataEnd = idx > 0 ? idx : undefined;
      }
      if (dataEnd > 0) {
        const dict = new Lexer(src, bodyStart).value();
        objects.set(num, {
          num,
          dict: dict.type === 'dict' ? dict : { type: 'dict', entries: new Map() },
          stream: buf.subarray(dataStart, dataEnd),
        });
        re.lastIndex = dataEnd;
        continue;
      }
    }
    if (endobj < 0) break;
    const dict = new Lexer(src, bodyStart).value();
    objects.set(num, {
      num,
      dict: dict.type === 'dict' ? dict : { type: 'dict', entries: new Map() },
      stream: null,
    });
    re.lastIndex = endobj + 6;
  }
  return objects;
}

/** 展开 /ObjStm 里的压缩对象（PDF 1.5+ 常见，页树常被压进去） */
function expandObjectStreams(objects) {
  for (const obj of [...objects.values()]) {
    if (obj.dict?.entries?.get('Type')?.value !== 'ObjStm') continue;
    const data = decodeStream(obj.stream, obj.dict);
    if (!data) continue;
    const count = Number(obj.dict.entries.get('N')?.value || 0);
    const first = Number(obj.dict.entries.get('First')?.value || 0);
    const header = data.subarray(0, first).toString('latin1').trim().split(/\s+/);
    for (let i = 0; i < count; i += 1) {
      const num = Number(header[i * 2]);
      const offset = Number(header[i * 2 + 1]);
      const nextOffset = i + 1 < count ? Number(header[(i + 1) * 2 + 1]) : data.length - first;
      if (!Number.isFinite(num) || !Number.isFinite(offset)) continue;
      const chunk = data.subarray(first + offset, first + nextOffset);
      const value = new Lexer(chunk.toString('latin1')).value();
      if (value.type === 'dict') objects.set(num, { num, dict: value, stream: null });
    }
  }
  return objects;
}

/** "N 0 R" / 内联字典 → 统一的 { dict, stream } 包装（需要 stream 时用它） */
function objOf(objects, node) {
  if (!node) return null;
  if (node.type === 'ref') return objects.get(node.num) || null;
  if (node.type === 'dict') return { dict: node, stream: null };
  return null;
}

/** 把值解成 dict 节点（只关心字典内容时用它） */
const resolve = (objects, node, depth = 0) => {
  if (!node || depth > 8) return null;
  if (node.type === 'ref') {
    const obj = objects.get(node.num);
    return obj ? resolve(objects, obj.dict, depth + 1) : null;
  }
  return node;
};

/* ═════════════════════════════ 字体 / ToUnicode ═════════════════════════════ */

const utf16be = (buf) => {
  let out = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const code = (buf[i] << 8) | buf[i + 1];
    if (code >= 0xd800 && code <= 0xdbff && i + 3 < buf.length) {
      const low = (buf[i + 2] << 8) | buf[i + 3];
      out += String.fromCharCode(code, low);
      i += 2;
    } else if (code !== 0) out += String.fromCharCode(code);
  }
  if (buf.length === 1 && buf[0]) out += String.fromCharCode(buf[0]);
  return out;
};

/** 解析 ToUnicode CMap：bfchar / bfrange → Map<code, string> + 码长 */
function parseCMap(data) {
  const text = data.toString('latin1');
  const map = new Map();
  let codeBytes = 0;
  const codespace = /begincodespacerange([\s\S]*?)endcodespacerange/.exec(text);
  if (codespace) {
    const hex = /<([0-9a-fA-F]+)>/.exec(codespace[1]);
    if (hex) codeBytes = Math.ceil(hex[1].length / 2);
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      if (!codeBytes) codeBytes = Math.ceil(pair[1].length / 2);
      map.set(parseInt(pair[1], 16), utf16be(Buffer.from(pair[2], 'hex')));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const body = block[1];
    const single = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g;
    let m;
    while ((m = single.exec(body))) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (!codeBytes) codeBytes = Math.ceil(m[1].length / 2);
      const base = Buffer.from(m[3], 'hex');
      if (hi - lo > 65535) continue;
      for (let code = lo; code <= hi; code += 1) {
        const next = Buffer.from(base);
        // 低字节递增（Unicode 连续段）
        for (let i = next.length - 1; i >= 0; i -= 1) {
          const add = code - lo;
          const sum = next[i] + add;
          next[i] = sum & 0xff;
          if (sum <= 0xff) break;
        }
        map.set(code, utf16be(next));
      }
    }
    for (const arr of body.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*\[([\s\S]*?)\]/g)) {
      const lo = parseInt(arr[1], 16);
      const items = [...arr[3].matchAll(/<([0-9a-fA-F]*)>/g)];
      items.forEach((item, idx) => map.set(lo + idx, utf16be(Buffer.from(item[1], 'hex'))));
    }
  }
  return { map, codeBytes: codeBytes || 1 };
}

/** 页面的 /Font 资源 → { F1: {map, codeBytes, widths, dw} } */
function buildFontMaps(objects, resources) {
  const fonts = new Map();
  const fontNode = resolve(objects, resources?.entries?.get('Font'));
  if (!fontNode || fontNode.type !== 'dict') return fonts;
  for (const [name, ref] of fontNode.entries) {
    const font = resolve(objects, ref);
    if (!font || font.type !== 'dict') continue;
    const subtype = font.entries.get('Subtype')?.value || '';
    const isType0 = subtype === 'Type0';
    const toUnicode = objOf(objects, font.entries.get('ToUnicode'));
    let parsed = { map: new Map(), codeBytes: isType0 ? 2 : 1 };
    if (toUnicode?.stream) {
      const data = decodeStream(toUnicode.stream, toUnicode.dict);
      if (data) parsed = parseCMap(data);
    }
    if (!parsed.map.size && isType0) parsed.codeBytes = 2;
    // 字宽：/W 决定每个 CID 的步进，判断词间空格要用（逐个定位的 PDF 必需）
    let widths = null;
    let dw = 1000;
    if (isType0) {
      const descendants = resolve(objects, font.entries.get('DescendantFonts'));
      const cidFont = resolve(objects, descendants?.type === 'array' ? descendants.items[0] : descendants);
      if (cidFont?.type === 'dict') {
        dw = Number(cidFont.entries.get('DW')?.value ?? 1000);
        const w = cidFont.entries.get('W');
        if (w?.type === 'array') {
          widths = new Map();
          const items = w.items;
          for (let i = 0; i < items.length; i += 1) {
            const first = items[i];
            if (first?.type !== 'number') continue;
            const next = items[i + 1];
            if (next?.type === 'array') {
              next.items.forEach((value, idx) => { if (value?.type === 'number') widths.set(first.value + idx, value.value); });
              i += 1;
            } else if (next?.type === 'number' && items[i + 2]?.type === 'number') {
              for (let cid = first.value; cid <= next.value; cid += 1) widths.set(cid, items[i + 2].value);
              i += 2;
            }
          }
        }
      }
    }
    fonts.set(name, { ...parsed, widths, dw });
  }
  return fonts;
}

/** 简单字体无 ToUnicode 时按 WinAnsi 近似（覆盖 0x80-0x9F 的常见符号） */
const WIN_ANSI = {
  0x80: '€', 0x82: '‚', 0x83: 'ƒ', 0x84: '„', 0x85: '…', 0x86: '†', 0x87: '‡',
  0x88: 'ˆ', 0x89: '‰', 0x8a: 'Š', 0x8b: '‹', 0x8c: 'Œ', 0x8e: 'Ž', 0x91: '‘',
  0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x98: '˜',
  0x99: '™', 0x9a: 'š', 0x9b: '›', 0x9c: 'œ', 0x9e: 'ž', 0x9f: 'Ÿ',
};

/** 解字符串 → { text, lastCode }；lastCode 用于查字宽判断词间空格 */
function decodeString(bytes, font) {
  const codes = [];
  if (!font?.map?.size) {
    for (const byte of bytes) codes.push(byte);
    return {
      text: codes.map((b) => WIN_ANSI[b] || String.fromCharCode(b)).join(''),
      lastCode: codes.at(-1) ?? 0,
    };
  }
  const width = font.codeBytes || 1;
  if (width === 2) {
    for (let i = 0; i + 1 < bytes.length; i += 2) codes.push((bytes[i] << 8) | bytes[i + 1]);
    if (bytes.length % 2) codes.push(bytes[bytes.length - 1]);
  } else {
    for (const byte of bytes) codes.push(byte);
  }
  const text = codes.map((code) => font.map.get(code) ?? (width === 2 ? '' : String.fromCharCode(code))).join('');
  return { text, lastCode: codes.at(-1) ?? 0 };
}

/* ═════════════════════════════ 内容流 → 文本 ═════════════════════════════ */

const isLatin = (s) => /[A-Za-z0-9]$/.test(s) && /^[A-Za-z0-9]/.test(s);

function extractContentText(content, fonts) {
  const lexer = new Lexer(content);
  const operands = [];
  let font = { map: new Map(), codeBytes: 1, widths: null, dw: 1000 };
  let fontSize = 0;
  let out = '';
  let pendingSpace = false;
  // 逐字定位的 PDF：步进来自 Td 的 tx 或 Tm 的 x 增量，与上一个字形字宽比较来判断词间空格
  let move = { dx: 0, fresh: false };
  let lastX = null;
  let lastY = null;
  let prevWidth = 1;
  const newline = () => { if (out && !/\n$/.test(out)) out += '\n'; };
  const widthOf = (code) => (font.widths?.get(code) ?? font.dw ?? 1000) / 1000;
  const emit = (decoded) => {
    if (!decoded?.text) return;
    if (move.fresh) {
      if (fontSize > 0 && Math.abs(move.dx) > 0.01 && move.dx / fontSize > prevWidth + 0.15) pendingSpace = true;
      move.fresh = false;
      prevWidth = widthOf(decoded.lastCode);
    }
    if (pendingSpace && out && !/\s$/.test(out) && isLatin(out.slice(-1) + decoded.text[0])) out += ' ';
    pendingSpace = false;
    out += decoded.text;
  };

  for (let guard = 0; guard < 500000; guard += 1) {
    lexer.skip();
    if (lexer.pos >= content.length) break;
    const ch = content[lexer.pos];
    // 内联字典（BI ... ID ... EI）直接跳过：图片数据里全是二进制噪声
    if (ch === 'B' && content.startsWith('BI', lexer.pos)) {
      const ei = content.indexOf('EI', lexer.pos);
      if (ei < 0) break;
      lexer.pos = ei + 2;
      continue;
    }
    if (ch === '<' && content[lexer.pos + 1] === '<') { operands.push(lexer.value()); continue; }
    if (ch === '[') { operands.push(lexer.value()); continue; }
    if (ch === '/' || ch === '(' || ch === '<' || ch === '+' || ch === '-' || ch === '.' || (ch >= '0' && ch <= '9')) {
      operands.push(lexer.value());
      continue;
    }
    if (!/[A-Za-z'"*]/.test(ch)) { lexer.pos += 1; continue; }
    // 操作符
    let op = '';
    while (lexer.pos < content.length && !WS.has(content[lexer.pos]) && !DELIM.has(content[lexer.pos])) {
      op += content[lexer.pos];
      lexer.pos += 1;
    }
    if (op === 'Tf') {
      const name = operands.filter((o) => o.type === 'name').at(-1)?.value;
      if (name && fonts.has(name)) font = fonts.get(name);
      const size = operands.filter((o) => o.type === 'number').at(-1)?.value;
      if (Number.isFinite(size) && size > 0) fontSize = size;
    } else if (op === 'Tj' || op === 'TJ') {
      const node = operands.at(-1);
      if (op === 'Tj') {
        if (node?.type === 'string') emit(decodeString(node.value, font));
      } else if (node?.type === 'array') {
        for (const item of node.items) {
          if (item.type === 'string') emit(decodeString(item.value, font));
          else if (item.type === 'number' && item.value < -120) pendingSpace = true;
        }
      }
    } else if (op === "'" || op === '"') {
      newline();
      const node = operands.at(-1);
      if (node?.type === 'string') emit(decodeString(node.value, font));
    } else if (op === 'Td' || op === 'TD') {
      const numbers = operands.filter((o) => o.type === 'number').slice(-2);
      const [tx, ty] = numbers.map((n) => n.value);
      if (Number.isFinite(ty) && Math.abs(ty) > 0.5) {
        newline();
        move = { dx: 0, fresh: false };
      } else if (Number.isFinite(tx)) {
        move = { dx: tx, fresh: true };
      }
    } else if (op === 'T*') {
      newline();
    } else if (op === 'Tm') {
      const numbers = operands.filter((o) => o.type === 'number').slice(-6);
      const x = numbers[4]?.value;
      const y = numbers[5]?.value;
      if (Number.isFinite(x) && Number.isFinite(y)) {
        if (lastY !== null && Math.abs(y - lastY) > 0.5) newline();
        move = { dx: lastX === null ? 0 : x - lastX, fresh: true };
        lastX = x;
        lastY = y;
      }
    } else if (op === 'ET') {
      // 文本对象结束：不强制换行，交给 Td/Tm 判断
    } else if (op === 'BI') {
      // 处理 "BI ... ID ... EI"：跳过二进制
      const idPos = content.indexOf('ID', lexer.pos);
      const eiPos = idPos > 0 ? content.indexOf('EI', idPos) : -1;
      if (eiPos > 0) lexer.pos = eiPos + 2;
    }
    operands.length = 0;
  }
  return out;
}

/* ═════════════════════════════ 页树 ═════════════════════════════ */

function collectPages(objects) {
  const pages = [];
  const isPage = (node) => node?.dict?.entries?.get('Type')?.value === 'Page';
  const isPages = (node) => node?.dict?.entries?.get('Type')?.value === 'Pages';

  // 从没有 /Parent 的 Pages 节点开始走（比依赖 trailer/Root 更抗损坏文件）
  const roots = [...objects.values()].filter((o) => isPages(o) && !o.dict.entries.has('Parent'));
  const walk = (node, inherited, seen) => {
    if (!node?.dict || seen.has(node.num) || seen.size > 5000) return;
    seen.add(node.num);
    const resources = node.dict.entries.get('Resources') ?? inherited;
    if (isPage(node)) { pages.push({ node, resources }); return; }
    const kids = resolve(objects, node.dict.entries.get('Kids'));
    if (kids?.type !== 'array') return;
    for (const kid of kids.items) walk(objOf(objects, kid), resources, seen);
  };
  const start = roots.length ? roots : [...objects.values()].filter(isPages);
  for (const root of start) walk(root, null, new Set());
  if (!pages.length) {
    for (const obj of objects.values()) if (isPage(obj)) pages.push({ node: obj, resources: obj.dict.entries.get('Resources') });
    pages.sort((a, b) => a.node.num - b.node.num);
  }
  return pages;
}

/* ═════════════════════════════ 对外入口 ═════════════════════════════ */

/**
 * @param {Buffer} buf
 * @returns {{text: string, pages: number, encrypted: boolean}}
 */
export function parsePdf(buf) {
  const head = buf.subarray(0, 1024).toString('latin1');
  if (!head.includes('%PDF')) throw new Error('不是有效的 PDF');
  if (/\/Encrypt\s/.test(buf.toString('latin1'))) {
    return { text: '', pages: 0, encrypted: true };
  }
  const objects = expandObjectStreams(scanObjects(buf));
  const pages = collectPages(objects);
  const chunks = [];
  for (const page of pages) {
    const fonts = buildFontMaps(objects, resolve(objects, page.resources));
    const contents = resolve(objects, page.node.dict.entries.get('Contents'));
    const streams = [];
    const pushStream = (ref) => {
      const streamObj = objOf(objects, ref);
      const data = decodeStream(streamObj?.stream, streamObj?.dict);
      if (data) streams.push(data);
    };
    if (contents?.type === 'array') contents.items.forEach(pushStream);
    else if (contents) pushStream(page.node.dict.entries.get('Contents'));
    if (!streams.length) continue;
    const text = extractContentText(Buffer.concat(streams.map((s) => Buffer.concat([s, Buffer.from('\n')]))).toString('latin1'), fonts);
    if (text.trim()) chunks.push(text.trim());
  }
  const text = chunks.join('\n\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { text, pages: pages.length || chunks.length, encrypted: false };
}

// 供冒烟/调试脚本单独验证各层（不对外承诺稳定）
export const __internals = { scanObjects, expandObjectStreams, collectPages, decodeStream, buildFontMaps, extractContentText, resolve };
