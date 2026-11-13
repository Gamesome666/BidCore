// 设置域：/api/settings 读取与保存、/api/llm/status。
import { run, jstr } from '../db.mjs';
import { nowIso } from '../lib/util.mjs';
import { sendJson, sendError, readBody } from '../lib/http.mjs';
import { assertQualityConfig } from '../domain/quality.mjs';
import { llmStatus } from '../domain/llm.mjs';
import { loadSettings } from '../seed.mjs';
import { requireUser } from './_ctx.mjs';

export function register(router) {
  router.add('GET', '/api/settings', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const settings = loadSettings();
    sendJson(res, 200, {
      ...settings,
      llm: { ...settings.llm, api_key: settings.llm.api_key ? '******' : '' },
      llm_status: llmStatus(),
    });
  });

  router.add('PUT', '/api/settings', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    if (user.role !== 'admin') return sendError(res, 403, 'ADMIN_ONLY', '仅管理员可修改平台设置');
    const body = await readBody(req);
    const current = loadSettings();
    const next = { ...current, ...body };
    if (next.quality) {
      try { assertQualityConfig(next.quality); } catch (error) { return sendError(res, 400, 'QUALITY_CONFIG_INVALID', String(error.message)); }
    }
    if (body.llm?.api_key === '******') next.llm.api_key = current.llm.api_key;
    // 防呆：选了 openai 却没给 key/base_url，直接报错，避免“以为接上了、其实还是模板”
    if (next.llm && String(next.llm.mode) === 'openai') {
      const merged = { ...current.llm, ...next.llm };
      if (!merged.api_key) return sendError(res, 400, 'LLM_KEY_REQUIRED', '运行模式为 openai 时必须填写 API Key，否则正文仍会用模板生成');
      if (!merged.base_url) return sendError(res, 400, 'LLM_BASE_URL_REQUIRED', '运行模式为 openai 时必须填写 Base URL（如 https://api.deepseek.com/v1）');
    }
    for (const key of ['llm', 'quality', 'workflow', 'review']) {
      if (!next[key]) continue;
      run(`INSERT INTO settings (key, value_json, updated_at) VALUES (?,?,?)
           ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`, key, jstr(next[key]), nowIso());
    }
    sendJson(res, 200, { success: true, settings: { ...loadSettings(), llm: { ...loadSettings().llm, api_key: '******' } } });
  });

  router.add('GET', '/api/llm/status', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    sendJson(res, 200, llmStatus());
  });
}
