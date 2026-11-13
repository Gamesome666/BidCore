// 知识库域：/api/knowledge 四库（doc/tool/company/personnel）过滤 + CRUD + 资料上传。
// 响应始终包含 library / file_name / meta_json / expires_at / files / parse，
// 前端可直接按库分页签、按解析状态提示，并把附件用 ?token= 喂给 <img>/<iframe>。
import { sendJson, sendError, readBody, readRawBody } from '../lib/http.mjs';
import { requireUser } from './_ctx.mjs';
import { parseMultipart } from '../lib/multipart.mjs';
import { id } from '../lib/util.mjs';
import {
  MAX_TOTAL_BYTES, MIME, validateFile, storeUpload, parseBuffer, summarizeParsed, emptyContent,
  appendFilesToDoc, reparseDoc, removeFileFromDoc, readStoredFile, removeDocDir,
} from '../domain/knowledge-files.mjs';
import {
  listKnowledge, getKnowledge, createKnowledge, updateKnowledge, deleteKnowledge,
  libraryCounts, expiringItems, outlineReferences, LIBRARIES, normalizeLibrary,
} from '../domain/knowledge.mjs';

const DEFAULT_CATEGORY = { doc: 'case', tool: 'product', company: 'qualification', personnel: 'cert' };

/** 文件名 → 素材标题（去掉扩展名；极端情况下兜底「未命名素材」） */
function titleFromFile(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '').trim();
  return base || '未命名素材';
}

/**
 * 读取并解析 multipart 请求。
 * 返回 null 表示已经写好错误响应（415 / 413 / 400）。
 */
async function readUploadForm(req, res) {
  const contentType = String(req.headers['content-type'] || '');
  if (!/^multipart\/form-data/i.test(contentType)) {
    sendError(res, 415, 'MULTIPART_INVALID', '上传接口只接受 multipart/form-data');
    return null;
  }
  let raw;
  try {
    raw = await readRawBody(req, MAX_TOTAL_BYTES + 2 * 1024 * 1024);
  } catch (error) {
    if (error.code === 'FILE_TOO_LARGE') {
      sendError(res, 413, 'FILE_TOO_LARGE', '上传内容超过 60MB 上限');
      // 客户端可能还在传：先把 413 刷出去，再断开连接，避免继续吃流量
      setTimeout(() => { try { req.destroy(); } catch { /* ignore */ } }, 80);
    } else {
      sendError(res, 400, 'MULTIPART_INVALID', `读取上传内容失败：${error.message}`);
    }
    return null;
  }
  try {
    return parseMultipart(raw, contentType);
  } catch (error) {
    sendError(res, 415, 'MULTIPART_INVALID', `multipart 解析失败：${error.message}`);
    return null;
  }
}

/** 文件级前置校验（数量/总量/单文件大小/扩展名/魔数），失败时直接写响应 */
function validateUploadFiles(res, files) {
  if (!files.length) {
    sendError(res, 400, 'FILE_REQUIRED', '请选择要上传的文件');
    return false;
  }
  const total = files.reduce((sum, file) => sum + file.data.length, 0);
  if (total > MAX_TOTAL_BYTES) {
    sendError(res, 413, 'FILE_TOO_LARGE', '单次上传总量超过 60MB');
    return false;
  }
  for (const file of files) {
    const problem = validateFile(file);
    if (problem) {
      sendError(res, problem.status, problem.code, problem.message);
      return false;
    }
  }
  return true;
}

/** 把一批上传文件追加到既有素材，并返回 {document, added} */
function appendToDoc(doc, files) {
  const result = appendFilesToDoc(doc, files);
  const document = updateKnowledge(doc.id, {
    content: result.content,
    fileName: result.added.at(-1)?.name || doc.file_name,
    meta: result.meta,
  });
  return { document, added: result.added };
}

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

  // ── 上传：每文件一个素材；带 docId 时改为批量追加到既有素材 ──────────────
  // 必须注册在 :id 路由之前（虽然方法/段数不同，保持"静态优先"的路由约定）
  router.add('POST', '/api/knowledge/upload', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const form = await readUploadForm(req, res);
    if (!form) return;

    const files = form.files.filter((file) => file.filename && file.data?.length);
    if (!validateUploadFiles(res, files)) return;
    const fields = form.fields || {};

    // docId：把文件追加到指定素材（等价于 POST /:id/files，方便前端统一走上传接口）
    if (fields.docId) {
      const doc = getKnowledge(String(fields.docId));
      if (!doc) return sendError(res, 404, 'DOC_NOT_FOUND', '素材不存在');
      try {
        const { document } = appendToDoc(doc, files);
        return sendJson(res, 201, { documents: [document], failed: [] });
      } catch (error) {
        return sendError(res, 400, 'FILE_REQUIRED', `附件写入失败：${error.message}`);
      }
    }

    const library = normalizeLibrary(String(fields.library || ''), fields.category);
    const category = String(fields.category || DEFAULT_CATEGORY[library] || 'case');
    const documents = [];
    const failed = [];

    for (const file of files) {
      let docId = '';
      try {
        docId = id('kdoc');
        // 先落盘（原件）再解析（正文派生），解析异常在 parseBuffer 内部已转成 status=error
        const entry = storeUpload(docId, file);
        const summary = summarizeParsed([{ name: file.filename, ...parseBuffer(file.data, entry.ext) }]);
        const title = String(fields.title || '').trim();
        const doc = createKnowledge({
          id: docId,
          title: title
            ? (files.length > 1 ? `${title} · ${titleFromFile(file.filename)}` : title)
            : titleFromFile(file.filename),
          library,
          category,
          folder: String(fields.folder || '').trim() || '资料上传',
          tags: String(fields.tags || ''),
          expiresAt: fields.expiresAt || fields.expires_at || null,
          content: summary.text || emptyContent(summary.parse),
          fileName: file.filename,
          meta: { files: [entry], parse: summary.parse },
        });
        documents.push(doc);
      } catch (error) {
        if (docId) removeDocDir(docId); // 素材没建成时别留孤儿目录
        failed.push({ name: file.filename, code: 'FILE_PARSE_ERROR', error: String(error?.message || error) });
      }
    }

    if (!documents.length) {
      return sendError(res, 400, 'FILE_REQUIRED', `文件全部处理失败：${failed.map((f) => f.name).join('、') || '未知原因'}`);
    }
    return sendJson(res, 201, { documents, failed });
  });

  // ── 追加附件并重解析 ----------
  router.add('POST', '/api/knowledge/:id/files', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const doc = getKnowledge(params.id);
    if (!doc) return sendError(res, 404, 'DOC_NOT_FOUND', '素材不存在');
    const form = await readUploadForm(req, res);
    if (!form) return;
    const files = form.files.filter((file) => file.filename && file.data?.length);
    if (!validateUploadFiles(res, files)) return;
    try {
      const { document, added } = appendToDoc(doc, files);
      return sendJson(res, 200, { document, added });
    } catch (error) {
      return sendError(res, 400, 'FILE_REQUIRED', `附件写入失败：${error.message}`);
    }
  });

  // ── 原件流：?download=1 变 attachment；图片/PDF 默认 inline 供预览 ──────────
  router.add('GET', '/api/knowledge/:id/files/:fileId', async ({ req, res, params, query }) => {
    // 浏览器 <img>/<iframe>/<a download> 不会带 Authorization，必须支持 ?token=
    const user = requireUser(req, res, query);
    if (!user) return;
    const doc = getKnowledge(params.id);
    if (!doc) return sendError(res, 404, 'DOC_NOT_FOUND', '素材不存在');
    const found = readStoredFile(doc, params.fileId);
    if (!found) return sendError(res, 404, 'FILE_NOT_FOUND', '附件不存在');
    if (!found.exists) return sendError(res, 404, 'FILE_NOT_FOUND', '附件文件已丢失');

    const download = String(query?.download || '') === '1';
    const mime = MIME[found.file.ext] || found.file.mime || 'application/octet-stream';
    const utf8Name = encodeURIComponent(found.file.name || found.file.stored || 'file');
    const asciiName = String(found.file.stored || 'file').replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '');
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': found.bytes,
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
      'Cache-Control': 'private, max-age=60',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(found.data);
  });

  // ── 删除单个附件（同时删磁盘文件并用剩余附件重建正文） ─────────────────
  router.add('DELETE', '/api/knowledge/:id/files/:fileId', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const doc = getKnowledge(params.id);
    if (!doc) return sendError(res, 404, 'DOC_NOT_FOUND', '素材不存在');
    const result = removeFileFromDoc(doc, params.fileId);
    if (!result) return sendError(res, 404, 'FILE_NOT_FOUND', '附件不存在');
    const document = updateKnowledge(doc.id, { content: result.content, meta: result.meta });
    sendJson(res, 200, { success: true, document, removed: result.removed.id });
  });

  // ── 重解析：按磁盘上的全部附件重建 content（手动改坏的正文可一键恢复） ───
  router.add('POST', '/api/knowledge/:id/reparse', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const doc = getKnowledge(params.id);
    if (!doc) return sendError(res, 404, 'DOC_NOT_FOUND', '素材不存在');
    const result = reparseDoc(doc);
    if (!result) return sendError(res, 400, 'FILE_REQUIRED', '该素材没有附件可重解析');
    const document = updateKnowledge(doc.id, { content: result.content, meta: result.meta });
    sendJson(res, 200, { document });
  });

  // ── 详情：给前端拿全文（列表接口保留 content 以兼容旧消费方） ───────────
  router.add('GET', '/api/knowledge/:id', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const doc = getKnowledge(params.id);
    if (!doc) return sendError(res, 404, 'DOC_NOT_FOUND', '素材不存在');
    sendJson(res, 200, doc);
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
