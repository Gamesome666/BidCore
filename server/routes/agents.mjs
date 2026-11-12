// Agent 域：/api/agents 列表与配置更新（团队是平台级共享配置，登录即可读，写操作仅 admin）。
// 与 yibiao 的 Agent 配置页对齐：模型档位（strong/standard/fast）、工具声明、系统提示词、启停。
import { all, get, run, jparse, jstr } from '../db.mjs';
import { sendJson, sendError, readBody } from '../lib/http.mjs';
import { requireUser } from './_ctx.mjs';

const TIERS = new Set(['strong', 'standard', 'fast']);

function shapeAgent(row) {
  if (!row) return null;
  return {
    ...row,
    tools: jparse(row.tools, []),
    enabled: Boolean(row.enabled),
  };
}

export function register(router) {
  router.add('GET', '/api/agents', async ({ req, res, query }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const rows = all('SELECT * FROM agents ORDER BY sort');
    const filtered = query?.enabled === '1' ? rows.filter((a) => a.enabled) : rows;
    sendJson(res, 200, filtered.map(shapeAgent));
  });

  router.add('GET', '/api/agents/:id', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const agent = get('SELECT * FROM agents WHERE id=?', params.id);
    if (!agent) return sendError(res, 404, 'AGENT_NOT_FOUND', 'Agent 不存在');
    sendJson(res, 200, shapeAgent(agent));
  });

  router.add('PUT', '/api/agents/:id', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const agent = get('SELECT * FROM agents WHERE id=?', params.id);
    if (!agent) return sendError(res, 404, 'AGENT_NOT_FOUND', 'Agent 不存在');
    if (user.role !== 'admin') return sendError(res, 403, 'ADMIN_ONLY', '仅管理员可修改 Agent 配置');
    const body = await readBody(req);
    const tier = body.modelTier ?? body.model_tier;
    if (tier !== undefined && !TIERS.has(String(tier))) {
      return sendError(res, 400, 'MODEL_TIER_INVALID', `未知模型档位：${tier}（可选 strong|standard|fast）`);
    }
    run(
      'UPDATE agents SET name=?, role=?, description=?, model_tier=?, system_prompt=?, enabled=?, tools=?, sort=? WHERE id=?',
      body.name ?? agent.name,
      body.role ?? agent.role,
      body.description ?? agent.description,
      tier !== undefined ? String(tier) : agent.model_tier,
      body.systemPrompt ?? body.system_prompt ?? agent.system_prompt,
      body.enabled === undefined ? agent.enabled : Number(body.enabled),
      jstr(body.tools ?? jparse(agent.tools, [])),
      body.sort === undefined ? agent.sort : Number(body.sort),
      agent.id,
    );
    sendJson(res, 200, shapeAgent(get('SELECT * FROM agents WHERE id=?', agent.id)));
  });
}
