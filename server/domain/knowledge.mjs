// 知识库领域（对标 yibiao 四库：方案模板 / 工具资产 / 公司资质 / 人员资质）。
// 表沿用 knowledge_docs（Lead 已在 db.mjs 里加了 library / file_name / meta_json 三列），
// 这里只做"库过滤 + 到期聚合 + 目录引用"三件事，CRUD 语义与原仓库一致（共享库，无 userId）。
import { all, get, run, jparse, jstr } from '../db.mjs';
import { id, nowIso } from '../lib/util.mjs';

export const LIBRARIES = [
  { key: 'doc', label: '方案模板库', note: '技术方案模板、章节素材与可复用写法' },
  { key: 'tool', label: '工具资产库', note: '自研平台、软著、采购与部署证明' },
  { key: 'company', label: '公司资质库', note: '体系认证、资质证书与到期提醒' },
  { key: 'personnel', label: '人员资质库', note: '一人多证：项目经理/工程师证书' },
];

const LIBRARY_KEYS = new Set(LIBRARIES.map((l) => l.key));

/** 由 category 推断库归属（老数据没有 library 时的兜底，与 db.mjs 回填规则一致） */
export function inferLibrary(category, fallback = 'doc') {
  const value = String(category || '');
  if (['company', 'qualification'].includes(value)) return 'company';
  if (['personnel', 'person'].includes(value)) return 'personnel';
  if (['tool', 'asset'].includes(value)) return 'tool';
  if (['template', 'case', 'doc'].includes(value)) return 'doc';
  return LIBRARY_KEYS.has(fallback) ? fallback : 'doc';
}

export function normalizeLibrary(library, category) {
  const value = String(library || '').trim();
  return LIBRARY_KEYS.has(value) ? value : inferLibrary(category);
}

function decorate(row) {
  if (!row) return null;
  return {
    ...row,
    library: row.library || inferLibrary(row.category),
    file_name: row.file_name || '',
    meta_json: row.meta_json || '{}',
    meta: jparse(row.meta_json, {}),
    expired: Boolean(row.expires_at) && new Date(row.expires_at).getTime() < Date.now(),
  };
}

/** 列表：library 过滤 + 关键词 + 到期窗口（days 为 0/undefined 时不过滤） */
export function listKnowledge({ library, q, expiringDays } = {}) {
  const where = [];
  const params = [];
  if (library && LIBRARY_KEYS.has(String(library))) {
    where.push('library = ?');
    params.push(String(library));
  }
  if (q) {
    where.push('(title LIKE ? OR content LIKE ? OR tags LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  const sql = `SELECT * FROM knowledge_docs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY library, category, title`;
  let rows = all(sql, ...params).map(decorate);
  if (expiringDays) {
    const limit = Date.now() + Number(expiringDays) * 86400_000;
    rows = rows.filter((row) => row.expires_at && new Date(row.expires_at).getTime() <= limit);
  }
  return rows;
}

export function getKnowledge(docId) {
  return decorate(get('SELECT * FROM knowledge_docs WHERE id=?', docId));
}

export function createKnowledge(body = {}) {
  const docId = id('kdoc');
  const category = String(body.category || 'case');
  run(
    'INSERT INTO knowledge_docs (id, title, folder, category, content, tags, expires_at, created_at, library, file_name, meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    docId,
    String(body.title || '未命名素材'),
    String(body.folder || '未分类'),
    category,
    String(body.content || ''),
    String(body.tags || ''),
    body.expiresAt || body.expires_at || null,
    nowIso(),
    normalizeLibrary(body.library, category),
    String(body.fileName || body.file_name || ''),
    jstr(body.meta || jparse(body.meta_json, {})),
  );
  return getKnowledge(docId);
}

export function updateKnowledge(docId, body = {}) {
  const doc = get('SELECT * FROM knowledge_docs WHERE id=?', docId);
  if (!doc) return null;
  const category = body.category ?? doc.category;
  run(
    'UPDATE knowledge_docs SET title=?, folder=?, category=?, content=?, tags=?, expires_at=?, library=?, file_name=?, meta_json=? WHERE id=?',
    body.title ?? doc.title,
    body.folder ?? doc.folder,
    category,
    body.content ?? doc.content,
    body.tags ?? doc.tags,
    body.expiresAt ?? body.expires_at ?? doc.expires_at,
    normalizeLibrary(body.library ?? doc.library, category),
    body.fileName ?? body.file_name ?? doc.file_name,
    jstr(body.meta ?? jparse(body.meta_json, {})) === 'null' ? (doc.meta_json || '{}') : jstr(body.meta ?? jparse(body.meta_json, {})),
    docId,
  );
  return getKnowledge(docId);
}

export function deleteKnowledge(docId) {
  const doc = get('SELECT id FROM knowledge_docs WHERE id=?', docId);
  if (!doc) return false;
  run('DELETE FROM knowledge_docs WHERE id=?', docId);
  return true;
}

/** 到期聚合：仪表盘/知识库顶部提醒用（跨四库） */
export function expiringItems(withinDays = 45) {
  const limit = Date.now() + Number(withinDays) * 86400_000;
  return all("SELECT * FROM knowledge_docs WHERE expires_at IS NOT NULL AND expires_at <> '' ORDER BY expires_at ASC")
    .map(decorate)
    .filter((row) => new Date(row.expires_at).getTime() <= limit)
    .map((row) => ({
      id: row.id,
      library: row.library,
      title: row.title,
      expires_at: row.expires_at,
      expired: row.expired,
      days_left: Math.round((new Date(row.expires_at).getTime() - Date.now()) / 86400_000),
    }));
}

/** 目录引用：把知识条目注入技术方案章节的素材（对齐 /knowledge-base/outline-references） */
export function outlineReferences(documentIds = []) {
  const ids = (documentIds || []).filter(Boolean);
  const rows = ids.length
    ? all(`SELECT * FROM knowledge_docs WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids)
    : all("SELECT * FROM knowledge_docs WHERE library IN ('doc','tool') ORDER BY created_at DESC LIMIT 20");
  return rows.map(decorate).map((row) => ({
    id: row.id,
    title: row.title,
    library: row.library,
    folder: row.folder,
    excerpt: String(row.content || '').slice(0, 180),
    tags: String(row.tags || ''),
  }));
}

/** 库统计：知识库页签的计数 */
export function libraryCounts() {
  const rows = all('SELECT library, COUNT(*) AS c FROM knowledge_docs GROUP BY library');
  const counts = Object.fromEntries(LIBRARIES.map((l) => [l.key, 0]));
  for (const row of rows) {
    const key = row.library || 'doc';
    counts[key] = (counts[key] || 0) + Number(row.c);
  }
  return counts;
}
