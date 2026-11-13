// 项目域：/api/projects 增删改查 + /api/projects/:id/tender + /api/projects/:id/workspace。
// 工作台快照（workspace）是前端项目页的首屏聚合：项目 + 技术方案 state + 最近运行 + 待审 + 质量 + 检查 + 导出历史。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { all, get, run, db, VAR_DIR, jparse } from '../db.mjs';
import { nowIso } from '../lib/util.mjs';
import { sendJson, sendError, readBody, readRawBody } from '../lib/http.mjs';
import { parseMultipart } from '../lib/multipart.mjs';
import { requireUser, canAccessProject } from './_ctx.mjs';
import { workspaceSnapshot, startStep } from '../domain/tasks.mjs';
import { extOf, parseBuffer, validateFile } from '../domain/knowledge-files.mjs';
import { parseTender } from '../domain/bid.mjs';
import { convertToDocx } from '../lib/officeConvert.mjs';

/** 招标文件接受的格式；.doc/.wps 会先用本机 Word/WPS 转成 docx 再解析 */
const TENDER_EXTS = new Set(['.docx', '.pdf', '.md', '.txt', '.doc', '.wps']);
const OFFICE_EXTS = new Set(['.doc', '.wps']);
const TENDER_UPLOAD_LIMIT = 26 * 1024 * 1024;

/**
 * 从上传文件里抽招标正文：常规格式直接解析，.doc/.wps 先转 docx。
 * 返回 { parsed, ext, originalExt } 或 { error:{status,code,message} }。
 */
async function extractTenderText(file) {
  const ext = extOf(file.filename);
  if (!TENDER_EXTS.has(ext)) {
    return { error: { status: 415, code: 'TENDER_FILE_UNSUPPORTED', message: `不支持 ${ext || '该'} 格式：请上传 docx / doc / wps / pdf / md / txt` } };
  }
  if (file.data.length > 25 * 1024 * 1024) {
    return { error: { status: 413, code: 'FILE_TOO_LARGE', message: '招标文件超过 25MB 上限' } };
  }
  if (OFFICE_EXTS.has(ext)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bidcore-doc-'));
    const input = path.join(dir, `input${ext}`);
    const output = path.join(dir, 'converted.docx');
    try {
      fs.writeFileSync(input, file.data);
      const converted = await convertToDocx(input, output);
      if (!converted.ok) {
        return {
          error: {
            status: 415,
            code: 'DOC_CONVERT_FAILED',
            message: `${ext} 转换失败（${converted.error}）。请用 Word/WPS 打开后「另存为 docx」再上传，或直接粘贴正文。`,
          },
        };
      }
      const parsed = parseBuffer(fs.readFileSync(output), '.docx');
      if (parsed.status !== 'ok' || !parsed.text) {
        return {
          error: {
            status: 415,
            code: 'DOC_CONVERT_FAILED',
            message: `${ext} 无法转换成可读文本（文件可能已损坏或受密码保护）。请另存为 docx 后重传，或直接粘贴正文。`,
          },
        };
      }
      return { parsed, ext: '.docx', originalExt: ext };
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响主流程 */ }
    }
  }
  const problem = validateFile(file);
  if (problem) return { error: problem };
  return { parsed: parseBuffer(file.data, ext), ext, originalExt: ext };
}

function shapeProject(project, extra = {}) {
  if (!project) return null;
  return {
    ...project,
    tender_text: undefined,
    tender_chars: String(project.tender_text || '').length,
    tender_meta: jparse(project.tender_meta_json, {}),
    ...extra,
  };
}

/** 删除前统计：告诉用户这个项目会带走多少关联数据 */
function deletionPreview(projectId) {
  const count = (sql, ...args) => Number(get(sql, ...args)?.c || 0);
  const runIds = all('SELECT id FROM runs WHERE project_id=?', projectId).map((row) => row.id);
  const marks = runIds.map(() => '?').join(',');
  return {
    runs: runIds.length,
    nodes: runIds.length ? count(`SELECT COUNT(*) c FROM node_runs WHERE run_id IN (${marks})`, ...runIds) : 0,
    artifacts: runIds.length ? count(`SELECT COUNT(*) c FROM artifacts WHERE run_id IN (${marks})`, ...runIds) : 0,
    events: runIds.length ? count(`SELECT COUNT(*) c FROM events WHERE run_id IN (${marks})`, ...runIds) : 0,
    reviews: runIds.length ? count(`SELECT COUNT(*) c FROM review_tasks WHERE run_id IN (${marks})`, ...runIds) : 0,
    quality: runIds.length ? count(`SELECT COUNT(*) c FROM quality_reports WHERE run_id IN (${marks})`, ...runIds) : 0,
    exports: count('SELECT COUNT(*) c FROM exports WHERE project_id=?', projectId),
    tasks: count('SELECT COUNT(*) c FROM tasks WHERE project_id=?', projectId),
    has_state: Boolean(get('SELECT project_id FROM project_state WHERE project_id=?', projectId)),
  };
}

/**
 * 删除项目及其全部关联数据。
 * sqlite 外键只覆盖 runs → node_runs/artifacts/events/commands/review_tasks → review_decisions/quality_reports；
 * 其余带 project_id 的表（tasks / project_state / exports）和 review_comments 需要显式清。
 */
function deleteProjectCascade(projectId) {
  const project = get('SELECT id, name FROM projects WHERE id=?', projectId);
  if (!project) return null;
  const counts = deletionPreview(projectId);
  const runIds = all('SELECT id FROM runs WHERE project_id=?', projectId).map((row) => row.id);
  const marks = runIds.map(() => '?').join(',');
  const exportFiles = all('SELECT path FROM exports WHERE project_id=?', projectId);

  db.exec('BEGIN IMMEDIATE');
  try {
    if (runIds.length) run(`DELETE FROM review_comments WHERE run_id IN (${marks})`, ...runIds);
    run('DELETE FROM runs WHERE project_id=?', projectId);
    run('DELETE FROM tasks WHERE project_id=?', projectId);
    run('DELETE FROM project_state WHERE project_id=?', projectId);
    run('DELETE FROM exports WHERE project_id=?', projectId);
    run('DELETE FROM projects WHERE id=?', projectId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败就交给上层 500 */ }
    throw error;
  }

  // 磁盘上的导出文件：只删 var/files 下的，防手滑删到仓库文件
  const fileRoot = path.resolve(VAR_DIR, 'files') + path.sep;
  let removedFiles = 0;
  for (const row of exportFiles) {
    const target = path.resolve(String(row.path || ''));
    if (!target.startsWith(fileRoot)) continue;
    try { fs.rmSync(target, { force: true }); removedFiles += 1; } catch { /* 被占用就留着 */ }
  }
  return { ...counts, files: removedFiles };
}

export function register(router) {
  router.add('GET', '/api/projects', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const rows = user.role === 'admin'
      ? all('SELECT p.*, (SELECT COUNT(*) FROM runs r WHERE r.project_id=p.id) AS run_count FROM projects p ORDER BY p.created_at DESC')
      : all('SELECT p.*, (SELECT COUNT(*) FROM runs r WHERE r.project_id=p.id) AS run_count FROM projects p WHERE p.owner_id=? ORDER BY p.created_at DESC', user.id);
    sendJson(res, 200, rows.map((p) => shapeProject(p, {
      latest_run: get('SELECT id, status, started_at FROM runs WHERE project_id=? ORDER BY started_at DESC LIMIT 1', p.id),
    })));
  });

  router.add('POST', '/api/projects', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const name = String(body.name || '').trim();
    if (!name) return sendError(res, 400, 'PROJECT_NAME_REQUIRED', '项目名称必填');
    const code = String(body.code || `XM${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`);
    if (get('SELECT id FROM projects WHERE code=?', code)) return sendError(res, 409, 'PROJECT_CODE_TAKEN', `项目编号已存在：${code}`);
    const now = nowIso();
    const result = run(
      'INSERT INTO projects (code, name, bidder_name, description, status, owner_id, tender_text, tender_name, created_at, updated_at, deadline, budget, industry, tender_meta_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      code, name, String(body.bidderName || body.bidder_name || '智标科技有限公司'), String(body.description || ''),
      'active', user.id, String(body.tenderText || body.tender_text || ''), String(body.tenderName || body.tender_name || '招标文件.md'),
      now, now, body.deadline || null, body.budget || null, String(body.industry || ''),
      JSON.stringify(body.tenderMeta || {}),
    );
    sendJson(res, 201, get('SELECT * FROM projects WHERE id=?', Number(result.lastInsertRowid)));
  });

  router.add('GET', '/api/projects/:id', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权访问该项目');
    sendJson(res, 200, {
      ...shapeProject(project),
      runs: all('SELECT id, status, objective, started_at, plan_version FROM runs WHERE project_id=? ORDER BY started_at DESC LIMIT 10', project.id),
      owner: get('SELECT id, username, display_name FROM users WHERE id=?', project.owner_id),
    });
  });

  router.add('PUT', '/api/projects/:id', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project || !canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权修改该项目');
    const body = await readBody(req);
    run(
      'UPDATE projects SET name=?, bidder_name=?, description=?, status=?, tender_text=?, tender_name=?, deadline=?, budget=?, industry=?, updated_at=? WHERE id=?',
      body.name ?? project.name,
      body.bidderName ?? body.bidder_name ?? project.bidder_name,
      body.description ?? project.description,
      body.status ?? project.status,
      body.tenderText ?? body.tender_text ?? project.tender_text,
      body.tenderName ?? body.tender_name ?? project.tender_name,
      body.deadline ?? project.deadline,
      body.budget ?? project.budget,
      body.industry ?? project.industry,
      nowIso(),
      project.id,
    );
    sendJson(res, 200, get('SELECT * FROM projects WHERE id=?', project.id));
  });

  router.add('GET', '/api/projects/:id/tender', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project || !canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权访问');
    sendJson(res, 200, { name: project.tender_name, text: project.tender_text });
  });

  // 项目工作台快照：state 为 project_state.data_json 的解析结果
  router.add('GET', '/api/projects/:id/workspace', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权访问该项目');

    const snapshot = workspaceSnapshot(project.id);
    sendJson(res, 200, {
      project: shapeProject(project, {
        owner: get('SELECT id, username, display_name FROM users WHERE id=?', project.owner_id),
      }),
      state: snapshot.state,
      latest_run: snapshot.latest_run,
      pending_reviews: snapshot.pending_reviews,
      quality: snapshot.quality,
      checks: snapshot.checks,
      exports: snapshot.exports,
    });
  });

  // 只解析、不落库：新建项目弹窗里「从文件导入」用，解析结果回填到文本框
  router.add('POST', '/api/tender/parse', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const contentType = String(req.headers['content-type'] || '');
    if (!/^multipart\/form-data/i.test(contentType)) {
      return sendError(res, 415, 'MULTIPART_INVALID', '上传接口只接受 multipart/form-data');
    }
    let raw;
    try {
      raw = await readRawBody(req, TENDER_UPLOAD_LIMIT);
    } catch (error) {
      if (error.code === 'FILE_TOO_LARGE') {
        sendError(res, 413, 'FILE_TOO_LARGE', '招标文件超过 25MB 上限');
        setTimeout(() => { try { req.destroy(); } catch { /* ignore */ } }, 80);
        return;
      }
      return sendError(res, 400, 'MULTIPART_INVALID', `读取上传内容失败：${error.message}`);
    }
    let form;
    try {
      form = parseMultipart(raw, contentType);
    } catch (error) {
      return sendError(res, 415, 'MULTIPART_INVALID', `multipart 解析失败：${error.message}`);
    }
    const file = (form.files || []).find((item) => item.filename && item.data?.length);
    if (!file) return sendError(res, 400, 'FILE_REQUIRED', '请选择招标文件（docx / doc / wps / pdf / md / txt）');
    const extracted = await extractTenderText(file);
    if (extracted.error) return sendError(res, extracted.error.status, extracted.error.code, extracted.error.message);
    const parsed = extracted.parsed;
    if (parsed.status !== 'ok' || !parsed.text) {
      if (extracted.ext === '.pdf') {
        return sendError(res, 422, 'PDF_NO_TEXT', `这份 PDF 没有文本层（扫描件/图片版），抽不出文字；请 OCR 后粘贴正文。`);
      }
      return sendError(res, 422, 'TENDER_PARSE_EMPTY', parsed.note || '未从文件中抽取到文本层');
    }
    let meta = {};
    try {
      const analysis = parseTender(parsed.text);
      const project = analysis.project || {};
      const pick = (re) => (re.exec(parsed.text)?.[1] || '').trim();
      meta = {
        name: project.name || pick(/项目名称\s*[|：:]\s*([^\n|]{3,40})/) || '',
        // 编号后面常跟「财政编号」，只取第一段
        code: String(project.code || '').split(/[\s，,（(]/)[0],
        owner: project.owner || pick(/采购人\s*[|：:]\s*([^\n|]{2,30})/) || '',
        budget: project.budget || pick(/预算(?:金额|限价)?\s*[|：:]\s*([^\n|]{2,30})/) || '',
        duration: project.duration || pick(/(?:合同履行期限|服务期限|工期)\s*[|：:]\s*([^\n|]{2,40})/) || '',
      };
    } catch { /* 解析元信息失败不影响回填正文 */ }
    sendJson(res, 200, { success: true, file: file.filename, kind: parsed.kind, chars: parsed.chars, pages: parsed.pages, text: parsed.text, meta });
  });

  // 项目级招标文件上传：docx/pdf/md/txt → 解析出正文 → 写入 projects.tender_text
  // fields.autoParse = '0' 时只落库，由前端接着走技术方案 parse 步骤（能拿进度条）
  router.add('POST', '/api/projects/:id/tender/upload', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权上传该项目的招标文件');

    const contentType = String(req.headers['content-type'] || '');
    if (!/^multipart\/form-data/i.test(contentType)) {
      return sendError(res, 415, 'MULTIPART_INVALID', '上传接口只接受 multipart/form-data');
    }
    let raw;
    try {
      raw = await readRawBody(req, TENDER_UPLOAD_LIMIT);
    } catch (error) {
      if (error.code === 'FILE_TOO_LARGE') {
        sendError(res, 413, 'FILE_TOO_LARGE', '招标文件超过 25MB 上限');
        setTimeout(() => { try { req.destroy(); } catch { /* ignore */ } }, 80);
        return;
      }
      return sendError(res, 400, 'MULTIPART_INVALID', `读取上传内容失败：${error.message}`);
    }
    let form;
    try {
      form = parseMultipart(raw, contentType);
    } catch (error) {
      return sendError(res, 415, 'MULTIPART_INVALID', `multipart 解析失败：${error.message}`);
    }

    const file = (form.files || []).find((item) => item.filename && item.data?.length);
    if (!file) return sendError(res, 400, 'FILE_REQUIRED', '请选择招标文件（docx / doc / wps / pdf / md / txt）');
    const extracted = await extractTenderText(file);
    if (extracted.error) return sendError(res, extracted.error.status, extracted.error.code, extracted.error.message);

    const parsed = extracted.parsed;
    if (parsed.status !== 'ok' || !parsed.text) {
      if (extracted.ext === '.pdf') {
        const pages = parsed.pages ? `（${parsed.pages} 页）` : '';
        return sendError(res, 422, 'PDF_NO_TEXT',
          `这份 PDF${pages}没有文本层，多半是扫描件/图片版，抽不出文字。请用 OCR 工具转成可复制文本后重传，或点「粘贴正文」把招标文本贴进来。`);
      }
      return sendError(res, 422, 'TENDER_PARSE_EMPTY', parsed.note || '未从文件中抽取到文本层');
    }
    if (parsed.text.length < 200) {
      if (extracted.ext === '.pdf') {
        return sendError(res, 422, 'PDF_NO_TEXT',
          `只抽取到 ${parsed.text.length} 字，这份 PDF 可能大部分是扫描页。请确认是可复制文字的版本，或点「粘贴正文」。`);
      }
      return sendError(res, 422, 'TENDER_TOO_SHORT', `只抽取到 ${parsed.text.length} 字，可能选错了文件（需要招标正文）`);
    }

    run('UPDATE projects SET tender_text=?, tender_name=?, updated_at=? WHERE id=?',
      parsed.text, file.filename, nowIso(), project.id);

    let task = null;
    if (String(form.fields?.autoParse ?? '1') !== '0') {
      try {
        const started = await startStep(project.id, 'parse', {}, user);
        task = started?.task || null;
      } catch (error) {
        task = { status: 'error', error: String(error.message || error) };
      }
    }

    sendJson(res, 200, {
      success: true,
      file: file.filename,
      kind: parsed.kind,
      chars: parsed.chars ?? parsed.text.length,
      pages: parsed.pages || 0,
      note: parsed.note,
      tender_name: file.filename,
      task,
    });
  });

  // 粘贴招标正文：扫描件 OCR 后或从别处复制文本时的兜底入口
  router.add('POST', '/api/projects/:id/tender/text', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权修改该项目的招标正文');
    const body = await readBody(req);
    const text = String(body.text || body.tenderText || '').trim();
    if (text.length < 200) return sendError(res, 400, 'TENDER_TOO_SHORT', `正文只有 ${text.length} 字，至少需要 200 字`);
    const name = String(body.name || project.tender_name || '招标正文（粘贴）').slice(0, 120);
    run('UPDATE projects SET tender_text=?, tender_name=?, updated_at=? WHERE id=?', text, name, nowIso(), project.id);
    let task = null;
    if (String(body.autoParse ?? '1') !== '0') {
      try {
        const started = await startStep(project.id, 'parse', {}, user);
        task = started?.task || null;
      } catch (error) {
        task = { status: 'error', error: String(error.message || error) };
      }
    }
    sendJson(res, 200, { success: true, chars: text.length, tender_name: name, task });
  });

  // 删除前预览：前端确认弹窗用，只读
  router.add('GET', '/api/projects/:id/deletion-preview', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT id, name FROM projects WHERE id=?', Number(params.id));
    if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权访问该项目');
    sendJson(res, 200, { project: { id: project.id, name: project.name }, counts: deletionPreview(project.id) });
  });

  // 删除项目：admin 可删任意项目，普通用户只能删自己负责的项目
  router.add('DELETE', '/api/projects/:id', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权删除该项目');
    const removed = deleteProjectCascade(project.id);
    if (!removed) return sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    sendJson(res, 200, { success: true, project_id: project.id, name: project.name, removed });
  });
}
