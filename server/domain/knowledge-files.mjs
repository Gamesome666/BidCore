// 知识库附件域：落盘 / 文件头校验 / 正文抽取 / meta_json 合并。
// 设计取舍：
//  · 上传同步解析（投标资料单文件 ≤25MB，docx/pdf 解析都在百毫秒级），接口返回时正文已可检索；
//  · 解析异常一律吞掉转成 status='error'，保证上传接口不 500、前端不白屏；
//  · 原件永久保留在 var/files/knowledge/<docId>/，正文只是派生物，可随时 reparse 重建。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { VAR_DIR, jparse } from '../db.mjs';
import { id, nowIso } from '../lib/util.mjs';
import { parseDocx } from '../lib/docparse/docx.mjs';
import { parsePdf } from '../lib/docparse/pdf.mjs';
import { decodeTextBuffer, decodeEntities, tidyText } from '../lib/docparse/xml.mjs';
import { readZip } from '../lib/zip.mjs';

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

export const ALLOWED_EXT = new Set([
  '.docx', '.pdf', '.md', '.txt', '.csv', '.xlsx',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp',
]);

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

export const MIME = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/** meta_json 可能是 'null' / 数组（历史数据或外部写入），统一收敛成对象 */
function metaOf(doc) {
  const parsed = jparse(doc?.meta_json, {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

const ROOT_DIR = path.resolve(VAR_DIR, 'files', 'knowledge');

export function extOf(name) {
  return path.extname(String(name || '')).toLowerCase();
}

/** 文件名消毒：去掉路径分隔符、穿越片段与 Windows 非法字符，保留中文与空格 */
export function sanitizeName(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const safe = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 96);
  return safe || 'file';
}

/* ═════════════════════════════ 存储路径 ═════════════════════════════ */

export function docDir(docId) {
  const dir = path.resolve(ROOT_DIR, sanitizeName(docId));
  if (dir !== ROOT_DIR && !dir.startsWith(`${ROOT_DIR}${path.sep}`)) throw new Error('非法的素材目录');
  return dir;
}

function storedPath(docId, stored) {
  const base = path.basename(String(stored || ''));
  if (!base || base !== String(stored) || base.includes('..')) throw new Error('非法的附件文件名');
  const dir = docDir(docId);
  const abs = path.resolve(dir, base);
  if (!abs.startsWith(`${dir}${path.sep}`)) throw new Error('附件路径越界');
  return abs;
}

export function removeDocDir(docId) {
  try { fs.rmSync(docDir(docId), { recursive: true, force: true }); } catch { /* 已不存在 */ }
}

/* ═════════════════════════════ 文件头校验 ═════════════════════════════ */

function startsWithBytes(buf, bytes) {
  if (!buf || buf.length < bytes.length) return false;
  for (let i = 0; i < bytes.length; i += 1) if (buf[i] !== bytes[i]) return false;
  return true;
}

/** 按扩展名复核魔数，防止把 exe/脚本改名成 .pdf 混进知识库 */
export function magicMatches(buf, ext) {
  const data = buf || Buffer.alloc(0);
  switch (ext) {
    case '.docx':
    case '.xlsx':
      return startsWithBytes(data, [0x50, 0x4b, 0x03, 0x04]);
    case '.pdf':
      return data.subarray(0, 1024).toString('latin1').includes('%PDF');
    case '.png':
      return startsWithBytes(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case '.jpg':
    case '.jpeg':
      return startsWithBytes(data, [0xff, 0xd8, 0xff]);
    case '.gif':
      return data.subarray(0, 6).toString('latin1') === 'GIF87a' || data.subarray(0, 6).toString('latin1') === 'GIF89a';
    case '.webp':
      return data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP';
    case '.bmp':
      return startsWithBytes(data, [0x42, 0x4d]);
    case '.md':
    case '.txt':
    case '.csv':
      // 文本没有魔数：拒绝前 8KB 出现 NUL 的二进制内容即可
      return !data.subarray(0, 8192).includes(0);
    default:
      return false;
  }
}

/**
 * 上传前置校验。
 * @returns {null | {status:number, code:string, message:string}}
 */
export function validateFile(file) {
  const name = String(file?.filename || '');
  const data = file?.data;
  const ext = extOf(name);
  if (!data || !data.length) {
    return { status: 415, code: 'FILE_TYPE_UNSUPPORTED', message: `空文件：${name || '未命名'}` };
  }
  if (data.length > MAX_FILE_BYTES) {
    return { status: 413, code: 'FILE_TOO_LARGE', message: `${name} 超过 25MB 上限` };
  }
  if (!ALLOWED_EXT.has(ext)) {
    return { status: 415, code: 'FILE_TYPE_UNSUPPORTED', message: `不支持的文件类型：${ext || '无扩展名'}（${name}）` };
  }
  if (!magicMatches(data, ext)) {
    return { status: 415, code: 'FILE_TYPE_UNSUPPORTED', message: `文件内容与扩展名 ${ext} 不符（${name}）` };
  }
  return null;
}

/* ═════════════════════════════ 正文抽取 ═════════════════════════════ */

/** xlsx 最小抽取：共享字符串 + 每行单元格按 " | " 拼接（投标资料里的清单/业绩表够用） */
function parseXlsx(buf) {
  const entries = readZip(buf);
  const sharedXml = entries.get('xl/sharedStrings.xml')?.toString('utf8') || '';
  const shared = [];
  for (const block of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
    shared.push(decodeEntities(
      [...block[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''),
    ));
  }
  const sheets = [...entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const lines = [];
  for (const sheet of sheets) {
    const xml = entries.get(sheet).toString('utf8');
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cell[1];
        const body = cell[2];
        const type = /t="([^"]*)"/.exec(attrs)?.[1] || '';
        if (type === 'inlineStr') {
          cells.push(decodeEntities([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join('')));
        } else {
          const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '';
          cells.push(type === 's' ? (shared[Number(raw)] ?? '') : decodeEntities(raw));
        }
      }
      const line = cells.map((value) => String(value).replace(/\s+/g, ' ').trim()).join(' | ').trim();
      if (line.replace(/[\s|]/g, '')) lines.push(line);
    }
  }
  return { text: tidyText(lines.join('\n')), blocks: lines.length };
}

/**
 * 按扩展名解析正文。
 * 永远不抛异常：失败返回 status='error' + note，让素材仍可入库并提示人工补摘要。
 * @returns {{status:'ok'|'empty'|'unsupported'|'image'|'error', kind:string, chars:number, pages:number, note:string, at:string, text:string}}
 */
export function parseBuffer(buf, ext) {
  const at = nowIso();
  const fail = (note) => ({ status: 'error', kind: ext.replace(/^\./, '') || 'file', chars: 0, pages: 0, note, at, text: '' });
  try {
    if (ext === '.docx') {
      const { text, blocks } = parseDocx(buf);
      const clean = tidyText(text);
      return {
        status: clean ? 'ok' : 'empty',
        kind: 'docx',
        chars: clean.length,
        pages: 0,
        note: clean ? `DOCX 已抽取 ${blocks} 个段落/表格块` : 'DOCX 未识别到文本',
        at,
        text: clean,
      };
    }
    if (ext === '.pdf') {
      const result = parsePdf(buf);
      if (result.encrypted) {
        return { status: 'empty', kind: 'pdf', chars: 0, pages: 0, note: 'PDF 已加密，无法抽取文本；请解密后重新上传', at, text: '' };
      }
      const clean = tidyText(result.text);
      return {
        status: clean ? 'ok' : 'empty',
        kind: 'pdf',
        chars: clean.length,
        pages: result.pages || 0,
        note: clean
          ? `PDF 共 ${result.pages || 0} 页，已抽取文本`
          : 'PDF 没有文本层（扫描件/纯图片），请手动补充摘要',
        at,
        text: clean,
      };
    }
    if (ext === '.xlsx') {
      const { text, blocks } = parseXlsx(buf);
      return {
        status: text ? 'ok' : 'empty',
        kind: 'xlsx',
        chars: text.length,
        pages: 0,
        note: text ? `XLSX 已抽取 ${blocks} 行` : 'XLSX 未识别到文本',
        at,
        text,
      };
    }
    if (ext === '.md' || ext === '.txt' || ext === '.csv') {
      const clean = tidyText(decodeTextBuffer(buf));
      return {
        status: clean ? 'ok' : 'empty',
        kind: 'text',
        chars: clean.length,
        pages: 0,
        note: clean ? '文本文件已导入' : '文本文件为空',
        at,
        text: clean,
      };
    }
    if (IMAGE_EXT.has(ext)) {
      return { status: 'image', kind: 'image', chars: 0, pages: 0, note: '图片原件已保存（未做 OCR）', at, text: '' };
    }
    return { status: 'unsupported', kind: ext.replace(/^\./, '') || 'file', chars: 0, pages: 0, note: `暂不支持 ${ext || '该'} 格式`, at, text: '' };
  } catch (error) {
    return fail(String(error?.message || error).slice(0, 200));
  }
}

/** 汇总多份解析结果：正文拼接、状态取最需要人工关注的一种 */
export function summarizeParsed(results) {
  const list = Array.isArray(results) ? results : [];
  const usable = list.filter((item) => String(item.text || '').trim());
  const text = usable.map((item) => String(item.text).trim()).join('\n\n').trim();
  const notes = list
    .map((item) => (item.note ? `${item.name ? `${item.name}: ` : ''}${item.note}` : ''))
    .filter(Boolean);

  let status = 'ok';
  if (!text) {
    if (list.some((item) => item.status === 'image')) status = 'image';
    else if (list.some((item) => item.status === 'error')) status = 'error';
    else if (list.length && list.every((item) => item.status === 'unsupported')) status = 'unsupported';
    else status = 'empty';
  }
  const kind = usable[0]?.kind || list.find((item) => item.kind)?.kind || 'text';
  const pages = list.reduce((sum, item) => sum + (Number(item.pages) || 0), 0);
  return {
    text,
    parse: {
      status,
      kind,
      chars: text.length,
      pages,
      note: notes.join('；').slice(0, 500),
      at: nowIso(),
    },
  };
}

/** 没有可检索正文时的占位文本（content 是 NOT NULL，且要提示人工补摘要） */
export function emptyContent(parse) {
  switch (parse?.status) {
    case 'image':
      return '（图片原件已保存，未做 OCR，请手动补充摘要）';
    case 'unsupported':
      return '（该格式暂不支持自动抽取文本，请下载原件后手动补充摘要）';
    case 'error':
      return `（解析失败：${parse.note || '未知错误'}；请手动补充摘要）`;
    case 'empty':
      return '（未识别到文本：可能是扫描件或空文档，请手动补充摘要）';
    default:
      return '';
  }
}

/* ═════════════════════════════ 落盘与 meta 合并 ═════════════════════════════ */

function sha256Of(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 写原件并返回 meta.files 里的一条记录 */
export function storeUpload(docId, file) {
  const fileId = id('file');
  const original = sanitizeName(file.filename);
  const ext = extOf(original);
  const stored = `${fileId}-${original}`;
  const dir = docDir(docId);
  fs.mkdirSync(dir, { recursive: true });
  const abs = storedPath(docId, stored);
  fs.writeFileSync(abs, file.data);
  return {
    id: fileId,
    name: String(file.filename || original),
    stored,
    ext,
    mime: MIME[ext] || 'application/octet-stream',
    bytes: file.data.length,
    sha256: sha256Of(file.data),
    added_at: nowIso(),
  };
}

/** 重新读取并解析磁盘上的全部附件，用于追加/重解析/删除附件后重建正文 */
export function rebuildFromFiles(docId, files) {
  const results = (Array.isArray(files) ? files : []).map((entry) => {
    try {
      const abs = storedPath(docId, entry.stored);
      if (!fs.existsSync(abs)) {
        return { name: entry.name, status: 'error', kind: extOf(entry.name).replace(/^\./, ''), chars: 0, pages: 0, note: '磁盘文件缺失', at: nowIso(), text: '' };
      }
      const parsed = parseBuffer(fs.readFileSync(abs), extOf(entry.name) || entry.ext || '');
      return { name: entry.name, ...parsed };
    } catch (error) {
      return { name: entry.name, status: 'error', kind: extOf(entry.name).replace(/^\./, ''), chars: 0, pages: 0, note: String(error?.message || error).slice(0, 200), at: nowIso(), text: '' };
    }
  });
  return summarizeParsed(results);
}

/** 追加附件：合并 files 数组（绝不覆盖旧条目），再按全部附件重建正文 */
export function appendFilesToDoc(doc, rawFiles) {
  const meta = metaOf(doc);
  const existing = Array.isArray(meta.files) ? meta.files : [];
  const added = rawFiles.map((file) => storeUpload(doc.id, file));
  const files = [...existing, ...added];
  const rebuilt = rebuildFromFiles(doc.id, files);
  return {
    added,
    meta: { ...meta, files, parse: rebuilt.parse },
    content: rebuilt.text || emptyContent(rebuilt.parse),
  };
}

/** 重解析：按 meta.files 全量重建正文 */
export function reparseDoc(doc) {
  const meta = metaOf(doc);
  const files = Array.isArray(meta.files) ? meta.files : [];
  if (!files.length) return null;
  const rebuilt = rebuildFromFiles(doc.id, files);
  return {
    meta: { ...meta, files, parse: rebuilt.parse },
    content: rebuilt.text || emptyContent(rebuilt.parse),
  };
}

/** 删除单个附件：先删磁盘，再用剩余附件重建正文 */
export function removeFileFromDoc(doc, fileId) {
  const meta = metaOf(doc);
  const files = Array.isArray(meta.files) ? meta.files : [];
  const target = files.find((file) => String(file.id) === String(fileId));
  if (!target) return null;
  try { fs.unlinkSync(storedPath(doc.id, target.stored)); } catch { /* 磁盘上已不存在 */ }

  const remaining = files.filter((file) => String(file.id) !== String(fileId));
  let content = doc.content;
  let parse = meta.parse || null;
  if (remaining.length) {
    const rebuilt = rebuildFromFiles(doc.id, remaining);
    content = rebuilt.text || emptyContent(rebuilt.parse);
    parse = rebuilt.parse;
  } else {
    parse = {
      status: 'empty',
      kind: target.ext ? String(target.ext).replace(/^\./, '') : '',
      chars: String(doc.content || '').length,
      pages: 0,
      note: '附件已全部删除',
      at: nowIso(),
    };
  }
  return { removed: target, meta: { ...meta, files: remaining, parse }, content };
}

/** 供下载/预览路由读取原件（找不到或路径不安全都返回 null） */
export function readStoredFile(doc, fileId) {
  const meta = metaOf(doc);
  const file = (Array.isArray(meta.files) ? meta.files : []).find((item) => String(item.id) === String(fileId));
  if (!file) return null;
  let abs;
  try { abs = storedPath(doc.id, file.stored); } catch { return null; }
  if (!fs.existsSync(abs)) return { file, abs, exists: false };
  const data = fs.readFileSync(abs);
  return { file, abs, exists: true, data, bytes: data.length };
}
