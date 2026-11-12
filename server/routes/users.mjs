// 用户管理（admin）
//  · GET   /api/users          [{id,username,display_name,role,title,department,modules}]
//  · POST  /api/users          新建（密码 hash 复用 lib/util.mjs 的 scrypt）
//  · PATCH /api/users/:id      改 role/title/department/modules/启停 status（可选重置密码）
// status 列由本模块按需补齐（db.mjs 的 ensureColumn 只覆盖了 title/department），老库也能直接跑。
import { all, get, run, exec, jparse, jstr } from '../db.mjs';
import { hashPassword, nowIso } from '../lib/util.mjs';
import { sendJson, sendError, readBody } from '../lib/http.mjs';
import { requireUser } from './_ctx.mjs';

const ROLES = new Set(['admin', 'user', 'reviewer']);

function ensureUserColumns() {
  const names = new Set(all('PRAGMA table_info(users)').map((c) => c.name));
  if (!names.has('title')) exec("ALTER TABLE users ADD COLUMN title TEXT DEFAULT ''");
  if (!names.has('department')) exec("ALTER TABLE users ADD COLUMN department TEXT DEFAULT ''");
  if (!names.has('status')) exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
}

function shapeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    role: row.role,
    title: row.title || '',
    department: row.department || '',
    modules: jparse(row.modules, []),
    status: row.status || 'active',
    created_at: row.created_at,
  };
}

export function register(router) {
  ensureUserColumns();

  router.add('GET', '/api/users', async ({ req, res, query }) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (user.role !== 'admin') return sendError(res, 403, 'ADMIN_ONLY', '仅管理员可查看用户列表');
    const status = query?.status ? String(query.status) : '';
    const rows = all(`SELECT * FROM users ${status ? 'WHERE status = ?' : ''} ORDER BY id`, ...(status ? [status] : []));
    sendJson(res, 200, rows.map(shapeUser));
  });

  router.add('POST', '/api/users', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (user.role !== 'admin') return sendError(res, 403, 'ADMIN_ONLY', '仅管理员可新建用户');
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username) return sendError(res, 400, 'USERNAME_REQUIRED', '账号必填');
    if (password.length < 6) return sendError(res, 400, 'PASSWORD_TOO_SHORT', '密码至少 6 位');
    if (get('SELECT id FROM users WHERE username=?', username)) return sendError(res, 409, 'USERNAME_TAKEN', `账号已存在：${username}`);

    const role = ROLES.has(String(body.role)) ? String(body.role) : 'user';
    const modules = Array.isArray(body.modules) ? body.modules.map(String) : [];
    const result = run(
      'INSERT INTO users (username, password_hash, display_name, role, modules, created_at, title, department, status) VALUES (?,?,?,?,?,?,?,?,?)',
      username,
      hashPassword(password),
      String(body.displayName || body.display_name || username),
      role,
      jstr(modules),
      nowIso(),
      String(body.title || ''),
      String(body.department || ''),
      String(body.status || 'active'),
    );
    sendJson(res, 201, shapeUser(get('SELECT * FROM users WHERE id=?', Number(result.lastInsertRowid))));
  });

  router.add('PATCH', '/api/users/:id', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (user.role !== 'admin') return sendError(res, 403, 'ADMIN_ONLY', '仅管理员可修改用户');
    const target = get('SELECT * FROM users WHERE id=?', Number(params.id));
    if (!target) return sendError(res, 404, 'USER_NOT_FOUND', '用户不存在');
    const body = await readBody(req);

    const role = body.role !== undefined ? String(body.role) : target.role;
    if (!ROLES.has(role)) return sendError(res, 400, 'ROLE_INVALID', `未知角色：${role}（可选 admin|user|reviewer）`);
    const status = body.status !== undefined ? String(body.status) : (target.status || 'active');
    if (!['active', 'disabled'].includes(status)) return sendError(res, 400, 'STATUS_INVALID', `未知状态：${status}（可选 active|disabled）`);
    if (target.id === user.id && status === 'disabled') return sendError(res, 409, 'CANNOT_DISABLE_SELF', '不能停用自己');

    const modules = body.modules !== undefined
      ? (Array.isArray(body.modules) ? body.modules.map(String) : jparse(body.modules, []))
      : jparse(target.modules, []);
    const password = String(body.password || '');

    run(
      'UPDATE users SET display_name=?, role=?, modules=?, title=?, department=?, status=? WHERE id=?',
      body.displayName ?? body.display_name ?? target.display_name,
      role,
      jstr(modules),
      body.title ?? target.title ?? '',
      body.department ?? target.department ?? '',
      status,
      target.id,
    );
    if (password) {
      if (password.length < 6) return sendError(res, 400, 'PASSWORD_TOO_SHORT', '密码至少 6 位');
      run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(password), target.id);
    }
    sendJson(res, 200, shapeUser(get('SELECT * FROM users WHERE id=?', target.id)));
  });
}
