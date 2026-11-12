// REST API 聚合器：按域拆分到 routes/*，这里只负责组装 router 并转出后台循环入口。
// 路由注册顺序 = 匹配优先级（lib/http.mjs 顺序匹配），不要随意调整：
// auth → projects → workflow-defs → runs → reviews → knowledge → agents → settings → compat。
import { createRouter } from './lib/http.mjs';
import { register as registerAuth } from './routes/auth.mjs';
import { register as registerProjects } from './routes/projects.mjs';
import { register as registerWorkflowDefs } from './routes/workflow-defs.mjs';
import { register as registerRuns } from './routes/runs.mjs';
import { register as registerReviews } from './routes/reviews.mjs';
import { register as registerKnowledge } from './routes/knowledge.mjs';
import { register as registerAgents } from './routes/agents.mjs';
import { register as registerSettings } from './routes/settings.mjs';
import { register as registerCompat } from './routes/compat.mjs';
import { register as registerDashboard } from './routes/dashboard.mjs';
import { register as registerTechnicalPlan } from './routes/technical-plan.mjs';
import { register as registerChecks } from './routes/checks.mjs';
import { register as registerExport } from './routes/export.mjs';
import { register as registerQuality } from './routes/quality.mjs';
import { register as registerUsers } from './routes/users.mjs';
import { register as registerAi } from './routes/ai.mjs';

export const router = createRouter();

// 顺序 = 匹配优先级：静态段在前、`:id` 在后，新增模块不要插到 auth/projects 之前。
registerAuth(router);
registerDashboard(router);
registerProjects(router);
registerAi(router);
registerTechnicalPlan(router);
registerChecks(router);
registerExport(router);
registerWorkflowDefs(router);
registerRuns(router);
registerReviews(router);
registerQuality(router);
registerKnowledge(router);
registerAgents(router);
registerSettings(router);
registerUsers(router);
registerCompat(router);

// 导出给 index 使用的后台循环入口
export { startBackgroundLoops } from './lib/loops.mjs';
export { authUser, canAccessProject } from './routes/_ctx.mjs';
