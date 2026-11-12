// 鉴权域：/api/auth/login、/api/me。
import { get, jparse } from '../db.mjs';
import { verifyPassword, signToken } from '../lib/util.mjs';
import { sendJson, sendError, readBody } from '../lib/http.mjs';
import { requireUser } from './_ctx.mjs';

export function register(router) {
  router.add('POST', '/api/auth/login', async ({ req, res }) => {
    const body = await readBody(req);
    const user = get('SELECT * FROM users WHERE username = ?', String(body.username || '').trim());
    if (!user || !verifyPassword(String(body.password || ''), user.password_hash)) {
      return sendError(res, 401, 'BAD_CREDENTIALS', '用户名或密码错误');
    }
    const token = signToken({ uid: user.id, role: user.role });
    sendJson(res, 200, {
      token,
      user: { id: user.id, username: user.username, display_name: user.display_name, role: user.role, modules: jparse(user.modules, []) },
    });
  });

  router.add('GET', '/api/me', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    sendJson(res, 200, { user: { ...user, modules: jparse(user.modules, []) } });
  });
}
