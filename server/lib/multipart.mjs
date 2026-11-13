// 极简 multipart/form-data 解析器（零依赖，只用 Buffer）。
// 只覆盖浏览器 <input type="file"> / FormData 产生的形态：
//   · 每段头以空行结束，文件名支持 filename="..." / filename*=UTF-8''...；
//   · 文件内容按原始字节返回，绝不转字符串（图片/PDF 会被破坏）；
//   · 普通字段按 UTF-8 解码，重名时后者覆盖前者。
// 不做：嵌套 multipart/mixed、quoted-printable、流式解析（上传上限 60MB，整包读入足够）。

const CRLFCRLF = Buffer.from('\r\n\r\n');
const MAX_PARTS = 500;

function boundaryOf(contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType || ''));
  return match ? (match[1] || match[2] || '') : '';
}

/** filename / filename* 的编码兜底：中文名可能以 UTF-8 原文或百分号编码出现 */
function decodeFilename(raw) {
  let value = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!value) return '';
  const extended = /^utf-8''(.+)$/i.exec(value);
  if (extended) value = extended[1];
  if (/%(?:[0-9a-fA-F]{2})/.test(value)) {
    try { return decodeURIComponent(value); } catch { /* 保留原值 */ }
  }
  return value;
}

/**
 * @param {Buffer} buf 完整请求体
 * @param {string} contentType 请求头 Content-Type
 * @returns {{fields: Record<string,string>, files: Array<{field:string,filename:string,contentType:string,data:Buffer}>}}
 */
export function parseMultipart(buf, contentType) {
  if (!/^multipart\/form-data/i.test(String(contentType || ''))) {
    throw new Error('不是 multipart/form-data 请求');
  }
  const boundary = boundaryOf(contentType);
  if (!boundary || boundary.length > 200) throw new Error('缺少或非法的 boundary');
  const delim = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];

  let pos = buf.indexOf(delim);
  if (pos < 0) throw new Error('请求体里找不到 multipart 边界');

  for (let guard = 0; pos >= 0 && guard < MAX_PARTS; guard += 1) {
    let start = pos + delim.length;
    // 结束标记 --boundary--
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    else break;

    const next = buf.indexOf(delim, start);
    if (next < 0) break;
    let end = next;
    // 去掉边界前的 CRLF（属于分隔符，不属于内容）
    if (end - 2 >= start && buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;

    if (end > start) {
      const part = buf.subarray(start, end);
      const split = part.indexOf(CRLFCRLF);
      const headers = split >= 0 ? part.subarray(0, split).toString('utf8') : '';
      const body = split >= 0 ? part.subarray(split + 4) : part;

      const disposition = /content-disposition:([^\r\n]*)/i.exec(headers)?.[1] || '';
      const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1]
        ?? /(?:^|;)\s*name=([^;\s]+)/i.exec(disposition)?.[1]
        ?? '';
      if (name) {
        const star = /filename\*\s*=\s*([^;\r\n]+)/i.exec(disposition)?.[1];
        const plain = /filename="([^"]*)"/i.exec(disposition)?.[1]
          ?? /filename=([^;\s]+)/i.exec(disposition)?.[1];
        const filename = decodeFilename(star !== undefined ? star : plain);
        if (filename) {
          files.push({
            field: name,
            filename,
            contentType: /content-type:([^\r\n]*)/i.exec(headers)?.[1]?.trim() || '',
            data: Buffer.from(body),
          });
        } else {
          fields[name] = body.toString('utf8');
        }
      }
    }
    pos = next;
  }

  return { fields, files };
}
