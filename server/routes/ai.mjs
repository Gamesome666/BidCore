// AI 辅助写作：用真实模型（OpenAI 兼容网关，默认 deepseek-v4.1-flash）精修 / 重写单章。
// 设计：只在「人工点击」时调用，避免整册 21 章串行烧钱；失败自动回退确定性正文并标注原因。
import { readBody, sendJson, sendError } from '../lib/http.mjs';
import { requireUser, canAccessProject } from './_ctx.mjs';
import { get } from '../db.mjs';
import { publish } from '../lib/bus.mjs';
import { projectState, saveChapter, listRequirements } from '../domain/tasks.mjs';
import { writeChapter } from '../domain/bid.mjs';
import { generateText, llmStatus, getLlmConfig } from '../domain/llm.mjs';
import { countChars } from '../domain/bid.mjs';

function chapterPrompt({ project, node, requirements, facts, instruction }) {
  return [
    `项目：${project.name}（采购人 ${project.tender_meta?.purchaser || '采购人'}）`,
    `章节：${node.number || ''} ${node.title}（目标字数 ${node.target_words || 300} 字以上）`,
    instruction ? `人工要求：${instruction}` : '',
    '请撰写该章节的投标技术方案正文，要求：',
    '1) 使用 Markdown，段落清晰，可用小标题与列表；不要输出整篇标书，只写本章。',
    '2) 逐条响应下列招标要求，引用具体指标（响应时间、可用性、人数等），不要空话。',
    '3) 不编造未提供的资质、证书编号或业绩；不确定的内容用"我方将按招标要求提供"表述。',
    '4) 不出现"待补充/TODO/XXX"等占位符。',
    requirements.length ? `招标要求：\n${requirements.map((r) => `- ${r.id}（${r.category}）${r.text}`).join('\n')}` : '',
    facts.length ? `已确认口径：\n${facts.slice(0, 6).map((f) => `- ${f.key}：${f.value}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

export function register(router) {
  router.add('POST', '/api/projects/:id/technical-plan/content/ai', async ({ req, res, params }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const project = get('SELECT * FROM projects WHERE id=?', Number(params.id));
    if (!project) return sendError(res, 404, 'PROJECT_NOT_FOUND', '项目不存在');
    if (!canAccessProject(user, project)) return sendError(res, 403, 'FORBIDDEN', '无权访问该项目');

    const body = await readBody(req);
    const nodeId = String(body.nodeId || body.node_id || '').trim();
    if (!nodeId) return sendError(res, 400, 'NODE_REQUIRED', '缺少 nodeId');
    const instruction = String(body.instruction || '').slice(0, 500);

    const state = projectState(project.id);
    const nodes = state.outline?.nodes || [];
    const node = nodes.find((n) => String(n.id) === nodeId);
    if (!node) return sendError(res, 404, 'OUTLINE_NODE_NOT_FOUND', '目录节点不存在，请先生成目录');

    const requirementIds = new Set(node.requirement_ids || []);
    const requirements = listRequirements(project.id).filter((r) => requirementIds.has(r.id));
    const facts = state.global_facts?.facts || [];
    const bidder = project.bidder_name || '我方';
    const index = nodes.findIndex((n) => String(n.id) === nodeId);

    const status = llmStatus();
    const fallbackMarkdown = writeChapter({
      node, requirements, facts, project: { name: project.name, bidder_name: bidder }, bidder, index: Math.max(0, index),
    });
    const started = Date.now();
    let markdown = fallbackMarkdown;
    let usedLlm = false;
    if (status.mode === 'openai' && status.ready) {
      markdown = await generateText({
        system: '你是资深投标技术方案主笔，输出严谨、可核验的中文 Markdown 正文，不编造资质与业绩。',
        user: chapterPrompt({ project, node, requirements, facts, instruction }),
        fallback: fallbackMarkdown,
      });
      usedLlm = !String(markdown).includes('LLM_FALLBACK');
      if (!usedLlm) markdown = fallbackMarkdown;
    }

    const saved = saveChapter(project.id, nodeId, markdown);
    const cfg = getLlmConfig();
    publish(project.id, 'tasks', {
      type: 'chapter.ai_generated',
      node_id: nodeId,
      words: countChars(markdown),
      llm: usedLlm,
    });
    publish(project.id, 'workflow', { type: 'project.state', project_id: project.id, step: 'content' });

    sendJson(res, 200, {
      node_id: nodeId,
      title: node.title,
      markdown,
      words: countChars(markdown),
      saved,
      llm: {
        used: usedLlm,
        mode: status.mode,
        model: usedLlm ? cfg.model : 'deterministic',
        provider: status.provider,
        ms: Date.now() - started,
      },
    });
  });

  // 模型连通性探活（设置页「测试连接」；也用于验收真实网关）
  router.add('POST', '/api/llm/probe', async ({ req, res }) => {
    const user = requireUser(req, res);
    if (!user) return;
    const { probeLlm } = await import('../domain/llm.mjs');
    sendJson(res, 200, await probeLlm());
  });
}
