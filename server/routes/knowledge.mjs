// 知识库域：/api/knowledge 四库（doc/tool/company/personnel）过滤 + CRUD。
// 响应始终包含 library / file_name / meta_json / expires_at，前端可直接按库分页签与到期提醒。
import { sendJson, sendError, readBody } from '../lib/http.mjs';
import { requireUser } from './_ctx.mjs';
import {
  listKnowledge, getKnowledge, createKnowledge, updateKnowledge, deleteKnowledge,
  libraryCounts, expiringItems, outlineReferences, LIBRARIES,
} from '../domain/knowledge.mjs';

export function register(router) {
  router.add('GET', '/api/knowledge', async ({ req, res, query }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const library = query?.library ? String(query.library) : '';
    if (library && !LIBRARIES.some((l) => l.key === library)) {
      return sendError(res, 400, 'LIBRARY_INVALID', `未知库：${library}（可选 ${LIBRARIES.map((l) => l.key).join('|')}）`);
    }
    const rows = listKnowledge({
      library,
      q: query?.q ? String(query.q) : '',
      expiringDays: query?.expiring ? Number(query.expiring) : 0,
    });
    sendJson(res, 200, rows);
  });

  // 库统计 + 到期聚合（知识库页签 / 仪表盘提醒）
  router.add('GET', '/api/knowledge/summary', async ({ req, res, query }) => {
    const user = requireUser(req, res);
    if (!user) return;
    sendJson(res, 200, {
      libraries: LIBRARIES,
      counts: libraryCounts(),
      expiring: expiringItems(Number(query?.withinDays || 45)),
    });
  });

  router.add('GET', '/api/knowledge/outline-references', async ({ req, res, query }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const documentIds = String(query?.documentIds || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    sendJson(res, 200, { references: outlineReferences(documentIds) });
  });

  router.add('POST', '/api/knowledge', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    if (!String(body.title || '').trim()) return sendError(res, 400, 'TITLE_REQUIRED', '标题必填');
    sendJson(res, 201, createKnowledge(body));
  });

  router.add('PUT', '/api/knowledge/:id', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (!getKnowledge(params.id)) return sendError(res, 404, 'DOC_NOT_FOUND', '素材不存在');
    const body = await readBody(req);
    sendJson(res, 200, updateKnowledge(params.id, body));
  });

  router.add('DELETE', '/api/knowledge/:id', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const removed = deleteKnowledge(params.id);
    if (!removed) return sendError(res, 404, 'DOC_NOT_FOUND', '素材不存在');
    sendJson(res, 200, { success: true });
  });
}
