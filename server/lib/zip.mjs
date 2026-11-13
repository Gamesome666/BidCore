// 极简 ZIP 读取器：只解包（store / deflate），给 docx / xlsx 之类的 OOXML 容器用。零依赖。
// 不做 ZIP64 / 加密 / 分卷：投标资料里的 Word 文档不会用这些特性。
import zlib from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** 从尾部找 EOCD（注释最长 65535 字节） */
function findEocd(buf) {
  const minStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minStart; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 解包 zip。
 * @param {Buffer} buf
 * @returns {Map<string, Buffer>} 条目名 → 解压后的内容
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 zip');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('zip 缺少中央目录');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset >= buf.length) throw new Error('zip 中央目录偏移越界');

  const entries = new Map();
  let pos = cdOffset;
  for (let n = 0; n < count && pos + 46 <= buf.length; n += 1) {
    if (buf.readUInt32LE(pos) !== CENTRAL_SIG) break;
    const method = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;

    if (!name || name.endsWith('/') || size === 0 && compressedSize === 0) continue;
    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) continue;
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    try {
      if (method === 0) entries.set(name, Buffer.from(data));
      else if (method === 8) entries.set(name, zlib.inflateRawSync(data));
    } catch {
      // 单个条目损坏不影响整包：调用方按缺失处理
    }
  }
  return entries;
}
