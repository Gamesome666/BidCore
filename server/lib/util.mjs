// 通用工具：ID / 时间 / 摘要 / 口令 / 令牌。零依赖（node:crypto）。
import crypto from 'node:crypto';

export function id(prefix = '') {
  return (prefix ? `${prefix}_` : '') + crypto.randomUUID().replace(/-/g, '').slice(0, 24);
}

export function nowIso() {
  return new Date().toISOString();
}

export function sha256(input) {
  return crypto.createHash('sha256').update(typeof input === 'string' ? input : JSON.stringify(input ?? null)).digest('hex');
}

export function clip(text, n = 400) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 清洗为合法文件名：去掉 Windows 非法字符、控制符与首尾空白/点号，压掉连续空白 */
export function safeFileName(name, fallback = '投标文件') {
  const clean = String(name ?? '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '');
  if (!clean) return fallback;
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}

/**
 * 同项目重名时追加数字后缀：项目名.docx → 项目名-2.docx → 项目名-3.docx。
 * taken 为已占用的完整文件名集合（不含路径）。
 */
export function resolveUniqueFileName(baseName, ext, taken = []) {
  const used = new Set(taken.map((f) => String(f || '')));
  const stem = safeFileName(baseName);
  let candidate = `${stem}${ext}`;
  if (!used.has(candidate)) return candidate;
  let n = 2;
  do {
    candidate = `${stem}-${n}${ext}`;
    n += 1;
  } while (used.has(candidate));
  return candidate;
}

export function hashPassword(password, salt = crypto.randomBytes(8).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'));
}

const SECRET = process.env.BIDCORE_SECRET || 'bidcore-demo-secret-change-me';

export function signToken(payload, ttlMs = 7 * 24 * 3600 * 1000) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  // 定长比较：先比长度再 timingSafeEqual，避免按字节提前返回的时序侧信道
  const left = Buffer.from(sig, 'base64url');
  const right = Buffer.from(expect, 'base64url');
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 文本分句（中文标点优先），用于查重/证据定位 */
export function splitSentences(text) {
  return String(text || '')
    .split(/[。！？!?；;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 8);
}

export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const v of A) if (B.has(v)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export function shingles(text, n = 2) {
  const clean = String(text || '').replace(/\s+/g, '');
  const out = [];
  for (let i = 0; i + n <= clean.length; i += 1) out.push(clean.slice(i, i + n));
  return out;
}
