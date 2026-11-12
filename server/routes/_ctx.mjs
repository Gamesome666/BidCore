// 路由共享上下文：鉴权用户解析 / 登录校验 / 项目归属判断。逻辑自 api.mjs 原样搬入。
import { get } from '../db.mjs';
import { verifyToken } from '../lib/util.mjs';
import { sendError } from '../lib/http.mjs';

export function authUser(req, query = {}) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const token = bearer || String(query?.token || '');
  const payload = verifyToken(token);
  if (!payload) return null;
  return get('SELECT id, username, display_name, role, modules FROM users WHERE id = ?', payload.uid) || null;
}

export function requireUser(req, res, query = {}) {
  const user = authUser(req, query);
  if (!user) { sendError(res, 401, 'UNAUTHORIZED', '请先登录'); return null; }
  return user;
}

export function projectIdOf(req, query = {}, body = {}) {
  return Number(body.projectId ?? query.projectId ?? req.headers['x-project-id'] ?? 0);
}

export function canAccessProject(user, project) {
  return Boolean(project) && (user.role === 'admin' || project.owner_id === user.id);
}
