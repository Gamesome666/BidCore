# PARITY-yibiao · 接口与信息架构对标文档

> **本文性质**：对公开仓库 [jdcome/OpenBidKit-Yibiao-Web](https://github.com/jdcome/OpenBidKit-Yibiao-Web)（AGPL-3.0）
> 的**结构与接口分析笔记**，用于确定 BidCore 的信息架构与兼容层契约。
> 文中不含、也不转述对方源码实现；BidCore 的服务端/前端均为独立实现（`node:http` + `node:sqlite` + 原生 ES Module，
> 与其 Fastify + Prisma/PostgreSQL + React/Vite 技术栈无共用代码）。
> 引用行号指向该公开仓库的提交，随上游演进而失效，仅作溯源用。

> 基准仓库：`OpenBidKit-Yibiao-Web/`（Fastify 5 + Prisma/PostgreSQL + React 19 + Vite）。
> 用途：作为"重写一个对标 yibiao 的 Web 应用"的契约基线。所有结论均出自仓库真实代码，行号即证据。
> 路径约定：除特别说明外，路径相对 `OpenBidKit-Yibiao-Web/`；`c:39` 表示该文件第 39 行。

## 0. 一眼结论

| # | 结论 | 证据 |
|---|---|---|
| 1 | 默认前缀 `/api`；鉴权=JWT `Authorization: Bearer`；**项目域靠 `X-Project-Id` 头**，SSE 用 `?projectId=` | `server/src/index.ts:134-207`、`server/src/auth/middleware.ts:108-135` |
| 2 | 前端 `SectionId` 是"路由 + 权限 + 菜单"三合一的唯一标识，页面切换不经过 URL 路由，而是 `activeSection` 状态机 | `client/src/shared/types/navigation.ts:1-34`、`client/src/app/AppRouter.tsx:37-118` |
| 3 | 技术方案是**单文档全量状态 RPC**：`GET /technical-plan/state` 返回整棵 `TechnicalPlanState`，所有写路由也都回整棵 | `server/src/routes/technical-plan.ts:1-3,16`、`server/src/technical-plan/store.ts:779-851` |
| 4 | 长任务统一 9 个 `POST /tasks/start-*`，返回 `BackgroundTaskState`(snake_case)，后续进度只走 SSE `tasks` 通道 | `server/src/tasks/service.ts:686-748`、`server/src/tasks/types.ts:38-85` |
| 5 | 并发模型 = "任务组独占 + payload 签名防重"；正文可暂停/续跑，崩溃后由 `get-active` 触发恢复 | `server/src/tasks/service.ts:360-395,398-421,660-667` |
| 6 | 人机协作只有 3 条真实链路：Agent ask-user 提问、偏离表 review→confirm、目录策略确认；导出前置校验是最后一道闸 | 见 §5 |
| 7 | 单条 SSE 复用连接，`event:` 即 channel 名（5 个），前端按 channel 解复用 | `server/src/events/bus.ts:13-25`、`client/src/shared/api/sse.ts:14,92-112` |

---

## 1. 信息架构

### 1.1 菜单树（真实结构与作用）

| 一级 | 二级 section | 页面组件 | 作用（来自菜单描述与页面实现） | 核心 |
|---|---|---|---|---|
| `dashboard` | — | `DashboardPage` | 项目总览、统计卡、项目卡（进度）、资质到期 widget、新建项目 | ★ |
| `bid-generation` | （父级→`SecondaryMenuPage`） | — | 标书生成能力聚合 | — |
|  | `technical-plan` | `TechnicalPlanHome workflowKind="technical-plan"` | 从招标文件重头写技术方案（6 步流水线） | ★ |
|  | `existing-plan-expansion` | `TechnicalPlanHome workflowKind="existing-plan-expansion"` | 上传已写方案→扩写加厚（同一组件、不同 workflowKind） |  |
|  | `business-bid` | `BusinessBidPage` | 投标计算器（菜单 `notice`：开发中） |  |
|  | `response-deviation-table` | `ResponseDeviationWorkbenchPage` | 复用招标原文生成"技术响应与偏离表"，人工填写响应 | ★ |
| `template-settings` | `my-templates` | `MyTemplatesPage` | 已保存导出模板列表（增删改/共享） |  |
|  | `new-template` | `ExportFormatPage mode="create"` | Word 排版模板编辑（7 个配置页签） | ★(=`export-format`) |
| `knowledge-base` | `document-knowledge-base` | `KnowledgeBasePage` | 方案模板库：文件夹/文档/条目抽取 | ★ |
|  | `tool-asset-library` | `AssetLibraryPage library="tool"` | 工具模板库：截图、软著、采购证明 | ★ |
|  | `company-qualification-library` | `AssetLibraryPage library="company"` | 公司资质库（到期提醒） | ★ |
|  | `personnel-qualification-library` | `PersonnelLibraryPage` | 人员资质库：一人多证（到期提醒） | ★ |
| `bid-check` | `duplicate-check` | `DuplicateCheckPage` | 标书查重：元数据/目录/正文/图片 4 个分析页签 | ★ |
|  | `rejection-check` | `RejectionCheckPage` | 废标项检查：废标项/错别字/逻辑谬误 3 类结果 | ★ |
| `docs` | `docs-usage` / `docs-config` | `DocsPage section=...` | 站内文档（usage/config） |  |
| `faq` | — | `FaqPage` | 问题反馈与解答 |  |
| `user-management` | — | `UserManagementPage` | 注册审批、停用/启用、角色与模块授权 | ★ |
| `prompt-management` | — | `PromptManagementPage` | 招标解析/废标检查 prompt 的 DB 化编辑 | ★ |
| （不在菜单） | `settings` | `SettingsPage` | 基本设置/通用/文本模型/生图模型/文件解析/智能体/AI 诊断 | ★ |
| （不在菜单） | `project-summary` | `ProjectSummaryPage` | 单项目摘要（STEP01 项目信息、投标主体代称替换） |  |
| `developer-test`（仅开发者模式） | `developer-json-test` 等 6 项 | `DeveloperTestPage` / `DeveloperDemoPage` / … | 调试台：JSON 解析、prompt lab、解析沙盘、导出演武、扩写替换、OpenCode Agent |  |

证据：菜单定义 `client/src/app/menuConfig.ts:4-145`、开发者菜单 `:147-191`；section 枚举 `client/src/shared/types/navigation.ts:1-34`；分派 `client/src/app/AppRouter.tsx:55-118`（二级菜单兜底 `:55-57`，settings 在 `:108`，project-summary 在 `:66`）。

### 1.2 路由与 section 契约

- `AppRouter` 入参 `activeSection`、`developerMode`、`onSectionChange`、`registerLeaveGuard`（`AppRouter.tsx:29-35`）。**没有 react-router**：深链只由权限回退兜底——当前 section 无权时强制回 `dashboard`（`:49-53`）。
- 父级 section（`bid-generation`/`template-settings`/`knowledge-base`/`bid-check`/`docs`/`developer-test`）渲染 `SecondaryMenuPage`，由它列出子项（`:55-57`）。
- 模板编辑是**同 section 内状态**：`my-templates` 命中 `editingTemplateId` 时内联渲染 `ExportFormatPage mode="edit"`，否则列表页（`:92-95`）。
- `export-format` 与 `new-template` 等价（都 `mode="create"`，`:96-99`）；`export-format` 保留在 `SectionId` 里作为历史别名。
- `settings` 与 `project-summary` 不在菜单树内，由顶栏/项目卡进入（`AppRouter.tsx:66,108`）。

### 1.3 权限模型（决定"谁能看到哪些 section"）

| 概念 | 规则 | 证据 |
|---|---|---|
| 可授予模块 | `template-settings`、`knowledge-base`、`bid-check`、`docs`、`faq`（`user-management` 仅展示不可授予） | `client/src/shared/permissions.ts:10-26` |
| 默认开放 | `dashboard`、`bid-generation`（含 4 个子能力） | `:29` |
| 子路由→模块映射 | `my-templates/new-template/export-format→template-settings`；4 个知识库→`knowledge-base`；`duplicate/rejection→bid-check`；`docs-*→docs` | `:32-48` |
| 判定顺序 | admin 全通 → `user-management`/`prompt-management` 仅 admin → 默认开放 → 模块命中 | `:59-71` |
| 服务端门禁 | `verifyToken` → `createRequireModule`（docs/faq/template-settings/knowledge-base/bid-check）→ `createRequireAdmin` → `createRequireProject` | `server/src/index.ts:138-208` |
| 项目归属 | 非 owner 且非 admin → 403 | `server/src/auth/middleware.ts:125-134` |

### 1.4 页面-接口归属（重写时按此切分前端模块）

| 页面 | 主要接口域 |
|---|---|
| Dashboard | `projects`、`asset-library/expiring`、`personnel/expiring`、`user config` |
| TechnicalPlanHome（6 步） | `technical-plan/*`、`tasks/start-{bid-section-extraction,bid-analysis,outline-generation,global-facts-generation,content-generation}`、`knowledge-base/outline-references`、`export/word` |
| ResponseDeviationWorkbench | `response-deviation/*`、`tasks/start-response-deviation-generation` |
| KnowledgeBasePage | `knowledge-base/*` |
| Asset/Personnel 库 | `asset-library/*`、`personnel/*` |
| DuplicateCheck | `duplicate-check/*`、`tasks/start-duplicate-analysis` |
| RejectionCheck | `rejection-check/*`、`tasks/start-{rejection-items-extraction,rejection-check}` |
| ExportFormat/MyTemplates | `templates/*`、`export/word`（测试导出） |
| Settings | `config`、`system-settings`、`ai/*`、`ai-diagnostics/*`、`agent/*` |
| UserManagement | `users/*` |
| PromptManagement | `prompts/*` |

---

## 2. 技术方案多步流水线

### 2.1 步骤模型（STEP 01-06）

| step | UI 标题 | 主页面 | 进入门禁（来自代码） |
|---|---|---|---|
| `document-analysis` | 选择标书 | `DocumentAnalysisPage` | 必须有 `tenderFile`；（扩写流程还须 `originalPlanFile`） |
| `bid-analysis` | 招标文件解析 | `BidAnalysisPage` | 必填解析项全部 success；多标段须已选定标段；无运行中任务 |
| `outline-generation` | 目录生成 | `OutlineEditPage` | `outlineData` 非空 |
| `global-facts` | 全局事实设定 | `GlobalFactsPage` | `globalFacts` 就绪 |
| `content-edit` | 生成正文 | `ContentEditPage` | 目录叶子节点 + 章节状态 |
| `expand` | 扩写改写 | 内联扩写面板（STEP 06） | 仅 `existing-plan-expansion` |

证据：`client/src/features/technical-plan/types.ts:3`；`client/src/features/technical-plan/pages/TechnicalPlanHome.tsx:46-62`（步骤+标签）、`:314-338`（逐项门禁与 tooltip）。

### 2.2 `technical-plan/state` 数据形状（前端契约）

```ts
// client/src/features/technical-plan/types.ts:267-301（服务端同构：server/src/technical-plan/store.ts:103-137）
interface TechnicalPlanState {
  workflowKind: 'technical-plan' | 'existing-plan-expansion';
  step: 'document-analysis' | 'bid-analysis' | 'outline-generation' | 'global-facts' | 'content-edit' | 'expand';
  tenderFile: TechnicalPlanTenderFile | null;        // fileName/markdownPath/markdownChars/contentHash/parserLabel/selectedSection*
  tenderFiles: TechnicalPlanTenderSourceFile[];      // 多标段源文件（id 化）
  originalPlanFile: TechnicalPlanOriginalPlanFile | null;
  projectOverview: string;                           // 派生自 bidAnalysisTasks.projectOverview.content（仅 success）
  techRequirements: string;                          // 同上
  bidAnalysisMode: 'key' | 'full' | 'custom';
  bidAnalysisSelectedTaskIds: string[];
  bidAnalysisTasks: Record<string, { id; label; status: 'idle'|'running'|'success'|'error'; content; error? }>;
  bidAnalysisProgress: number;
  bidSectionMode: 'single' | 'multiple';
  bidSections: DetectedBidSection[];                 // id/index/unit/title/headLine/description/includeRanges/evidence
  bidSectionExtractionStatus: 'idle'|'running'|'success'|'error';
  outlineMode: 'aligned';
  outlineExpansionMode: 'original-only' | 'ai-complement';
  outlineWordControlOptions?: { minWordsWan; maxWordsWan; wordsPerSectionWan; forceSectionWords };
  mirrorProcurementEnabled?: boolean;
  referenceKnowledgeDocumentIds: string[];
  bidSectionExtractionTask?; bidAnalysisTask?; outlineGenerationTask?; globalFactsTask?; contentGenerationTask?: BackgroundTaskState;
  globalFacts: { id: string; title: string; content: string; updated_at?: string }[];
  contentGenerationOptions?: ContentGenerationOptions;        // 见 §2.5
  contentGenerationSections: Record<string, { id; title; status: 'idle'|'running'|'success'|'error'; content; error?; updated_at? }>;
  contentGenerationPlans: Record<string, { plan_version; plan: { writing_focus?; knowledge:{item_ids[]}; facts:{titles[]}; table:{needed,purpose}; original_material? }; table_requirement?; updated_at? }>;
  contentIllustrationPlan?: { plan_version; revision; items: ContentIllustrationPlanItem[] };  // ai|mermaid|html 配图计划
  contentGenerationRuntime?: { phase?; touched_item_ids?; expansion_cycle_item_ids?; target_item_id?; regenerate_requirement? };
  outlineData: OutlineData | null;                   // {outline: OutlineItem[], project_name?, project_overview?, word_control_options?, word_control_snapshot?}
}
```

服务端装配点：`store.ts:817-850`（`projectOverview/techRequirements` 只在 success 时回填，`:824-825`；任务对象由 `...tasks` 展开，`:842`；`outlineData` 由 `loadOutlineData` 生成，`:784`）。初始状态对齐桌面：`store.ts:140-163`，前端 hydration 用同一个 `initialState` 兜底（`client/src/features/technical-plan/hooks/useTechnicalPlanWorkflow.ts:5-34,36-69`——纯本地缓存加载，**不做网络拉取**，网络拉取在各页面自行 `loadState()`）。

### 2.3 `BackgroundTaskState`（所有任务共用，snake_case）

```ts
// server/src/tasks/types.ts:38-57；前端镜像 client/src/shared/api/tasks.ts:10-25
interface BackgroundTaskState {
  task_id: string; type: string; status: 'running'|'pausing'|'paused'|'success'|'error';
  progress: number; logs: string[]; started_at: string; updated_at: string;
  error?: string; stats?: unknown; pause_requested: boolean;
  // 编排元数据（客户端一般只回传不读）
  group?: 'technical-plan'|'rejection-check'|'duplicate-check'|'response-deviation';
  step?: number; lock_policy?: 'group-exclusive'|'scope-exclusive'|'none';
  scope_id?: string; payload_signature?: string;
  diagnostic_trace_id?: string; degraded?: boolean; reused?: boolean;
}
```

`stats.content` 是正文任务的阶段机：`phase ∈ planning|restoring|generating|outline-expanding|expanding|original-auditing|auditing|table-cleaning|illustration-planning|illustration-generating|done`，并带 `planning_total/completed`、`generation_*`、`audit_*`、`illustration_*` 等计数（`client/src/features/technical-plan/types.ts:52-107`）。重写时**必须原样保留**，否则前端进度条无法复现。

### 2.4 九个 `tasks/start-*`：真实请求体

| 端点 | 触发点 | 请求体（真实） | 服务端读取键 | 初始 patch |
|---|---|---|---|---|
| `start-bid-section-extraction` | `BidAnalysisPage.tsx:444,481` | `{}` | — | 清空下游全部技术方案状态（`service.ts:686-693`） |
| `start-bid-analysis` | `BidAnalysisPage.tsx:389-394` | `{mode, selected_task_ids, task_ids?, force_rerun?}` | `mode`、`selected_task_ids/selectedTaskIds`、`task_ids`、`force_rerun/forceRerun`（`runners/bid-analysis.ts:74-123`） | `{}` |
| `start-outline-generation` | `OutlineEditPage.tsx:553-559` | `{reference_knowledge_document_ids, outline_expansion_mode, mirror_procurement, outline_word_control_options, debug_force_outline_agent_repair}` | 同名字段 + camelCase 兜底（`utils/outlineGenerationHelpers.ts:291-311`） | `outlineMode/outlineExpansionMode/referenceKnowledgeDocumentIds/mirrorProcurement`（`service.ts:699-707`） |
| `start-global-facts-generation` | `GlobalFactsPage.tsx:110` | `{}` | — | 清空 `globalFacts`+正文状态（`:709-711`） |
| `start-content-generation` | `ContentEditPage.tsx:710,723,736,787-803,894` | 5 种：`{resume:true}` / `{retryContentCorrection:true}` / `{rerunIllustrations:true}` / `{regenerate:boolean, generationOptions:{...}}` / `{targetItemId?, requirement?}` | `resume`、`retryContentCorrection`、`regenerate`、`targetItemId`、`requirement`、`generationOptions/generation_options`、`rerunIllustrations`（`runners/content-generation.ts:293-364`） | `{}` |
| `start-rejection-items-extraction` | `RejectionCheckPage.tsx:921` | `{tenderSignature}` | `tenderSignature`（runner 内部还会重算签名）+ `workspaceState` 作初始 patch | `payload.workspaceState`（`service.ts:732-735`） |
| `start-rejection-check` | `RejectionCheckPage.tsx:1080-1084` | `{checkOptions:{rejectionCheck,typoCheck,logicCheck}, runOptions:{...}, customCheckItems}` | `runOptions` 覆盖默认开关（`runners/rejection-check-run.ts:59-60`） | `payload.workspaceState`（`:737-740`） |
| `start-duplicate-analysis` | `DuplicateCheckPage.tsx:728` | `{tenderFile, tenderFiles, bidFiles, force}` | `force`、`bidFiles`、`tenderFiles/tenderFile`（`runners/duplicate-analysis.ts:521-526`、`utils/duplicateAnalysisHelpers.ts:147-151`） | `{}` |
| `start-response-deviation-generation` | `POST /response-deviation/generate {force}` | `{force:boolean}` | `userId`（`runners/response-deviation-generation.ts:74`） | `{status:'detecting'}`（`service.ts:746-748`） |

其它 2 条：`POST /tasks/pause-content-generation`（`:717-730`，无运行中任务时按库内状态抛 409）、`GET /tasks/active`（`:671-675`，先跑崩溃恢复再返回残留任务）。

### 2.5 关键子契约

| 契约 | 形状 | 证据 |
|---|---|---|
| `ContentGenerationOptions` | `{useAiImages,maxAiImages,useMermaidImages,maxMermaidImages,useHtmlImages,maxHtmlImages,htmlImageTypes,tableRequirement:'none'|'light'|'moderate'|'heavy',minimumWords?,enableConsistencyAudit,consistencyRepairMode:'agent'|'normal',enableOriginalPlanCoverageAudit,originalPlanCoverageRepairMode}` | `types.ts:24-38` |
| 保存目录 | `POST /technical-plan/outline {outlineData, reason:'sort'|'edit'|'delete'|'add-root'|'add-child'|'replace', idMap?, affectedNodeIds?}` | `types.ts:15-22`、`routes/technical-plan.ts:38-43` |
| 保存章节 | `POST /technical-plan/chapter-content {nodeId, content}` → 写 `outline_node.content` + upsert `content_section.status=success|idle`，并清空配图计划 | `store.ts:1486-1504` |
| 保存全局事实 | `POST /technical-plan/global-facts {globalFacts:[...]}` → 替换分组并清空正文生成状态 | `store.ts:1458-1479` |
| 选标段 | `POST /technical-plan/select-bid-section {selectedSection:{id,title}}` → `{success,message,state,markdown}` | `client/src/shared/api/technical-plan.ts:49-53` |
| 清空/切换工作流 | `/technical-plan/clear` → `{success,message,state}`；`/switch-workflow-kind` 有"任务运行中"守卫 | `routes/technical-plan.ts:59`、`store.ts:1365-1377` |

### 2.6 招标解析任务清单（决定 `bidAnalysisTasks` 的 key 集）

必填 5 项：`projectOverview`、`techRequirements`、`projectInfo`、`partAInfo`、`deliveryAndServiceRequirements`；可选 13 项：`procurementList`、`responseFileRequirements`、`agentInfo`、`keyInfo`、`marginInfo`、`qualificationReview`、`complianceCheck`、`openBid`、`evaluationBid`、`businessScoring`、`discardedBids`、`signingProcess`、`terminationCondition`（`store.ts:167-186`；`key` 模式=仅必填，`:188-190`）。

---

## 3. API 全量清单

> 全部挂 `/api`。标注 **P** = 需 `X-Project-Id`；**A** = 仅 admin；**M(x)** = 需模块 x。响应除特别说明均为 JSON。

### 3.1 auth（公开 3 + 受保护 1）

| # | 方法 | 路径 | 作用 | 关键入参/出参 | 证据 |
|---|---|---|---|---|---|
| 1 | POST | `/login` | 手机号+密码登录 | in `{username,password}`；out `{token,user}` 或 `{password_change_required,password_change_token,expires_in:600}` | `routes/auth.ts:46-85` |
| 2 | POST | `/change-initial-password` | 初始密码改密（凭证换正式 token） | in `{newPassword,confirmPassword}`；out `{token,user}` | `:87-152` |
| 3 | POST | `/register` | 注册（`status=pending`，`username=phone`） | in `{phone,password,displayName,department?}` | `:155-188` |
| 4 | GET | `/me` | 当前用户最新信息（前端 60s/聚焦刷新，权限即时生效） | out `{user}` | `:197-206` |

### 3.2 projects

| # | 方法 | 路径 | 作用 | 关键入参/出参 | 证据 |
|---|---|---|---|---|---|
| 5 | GET | `/projects` | 项目列表（owner=self，admin 全量）+ `ownerName`+`progress`+`isComplete` | out `Project[]` | `routes/projects.ts:111-142` |
| 6 | GET | `/projects/stats` | 仪表盘统计 | out `{total,active,thisMonth,completionRate,runningTasks}` | `:145-169` |
| 7 | POST | `/projects` | 新建（服务端生成 `projectCode`，自动激活；普通用户有未完成项目则 409） | in `{name,description?,bidderName?}` | `:172-198` |
| 8 | GET/PATCH | `/projects/:id` | 详情（含 `progress/isComplete/subjectReplacements`）/ 改 `name/description/bidderName/subjectReplacements/status` | | `:211-235` |
| 10 | DELETE | `/projects/:id` | 级联清工作区表 + 删工作区目录 + 删项目 | out `{success,message}` | `:238-256` |
| 11 | POST | `/projects/:id/activate` | 写 `UserConfig.activeProjectId` | out `{success,activeProjectId}` | `:259-265` |

### 3.3 technical-plan（**P**，全部返回整棵 state）

| # | 方法 | 路径 | 作用 | 入参 | 证据 |
|---|---|---|---|---|---|
| 12 | GET | `/technical-plan/state` | 读全量状态 | — | `routes/technical-plan.ts:16` |
| 13 | POST | `/technical-plan/step` | 切步骤 | `{step}` | `:18` |
| 14 | POST | `/technical-plan/workflow-kind` | 设工作流类型（不清理） | `{workflowKind}` | `:20` |
| 15 | POST | `/technical-plan/switch-workflow-kind` | 切换工作流（清域状态，运行中拒绝） | `{workflowKind}` | `:22`；`store.ts:1365` |
| 16 | POST | `/technical-plan/bid-analysis-config` | 存解析配置 | `{mode,selectedTaskIds,bidSectionMode?}` | `:24-29` |
| 17 | POST | `/technical-plan/outline-config` | 存目录配置 | `{referenceKnowledgeDocumentIds,outlineExpansionMode?,mirrorProcurementEnabled?,outlineWordControlOptions?}` | `:31-36` |
| 18 | POST | `/technical-plan/outline` | 存目录树 | `{outlineData,reason,idMap?,affectedNodeIds?}` | `:38-43` |
| 19 | POST | `/technical-plan/global-facts` | 替换全局事实 | `{globalFacts}` | `:45` |
| 20 | POST | `/technical-plan/content-generation-options` | 存正文生成选项 | `{options}` | `:47-49` |
| 21 | POST | `/technical-plan/chapter-content` | 存单章正文 | `{nodeId,content}` | `:51-53` |
| 22 | POST | `/technical-plan/select-bid-section` | 选标段并裁剪原文 | `{selectedSection:{id,title}}` → `{success,message,state,markdown}` | `:55-57` |
| 23 | POST | `/technical-plan/clear` | 清空技术方案 | — → `{success,message,state}` | `:59` |
| 24 | POST | `/technical-plan/import-tender-document` | multipart 导入招标（多文件合并） | `files[]` → `{success,message,state,markdown}`；415 缺 LibreOffice / 422 解析失败 | `:62-72` |
| 25 | POST | `/technical-plan/import-original-plan-document` | multipart 导入原方案（扩写） | `file` | `:74-84` |
| 26 | GET | `/technical-plan/tender-markdown`、`/tender-source-markdown/:sourceId`、`/original-plan-markdown` | 读招标 / 某标段源 / 原方案 markdown（可能空串） | — | `:87-91` |
| 29 | GET | `/technical-plan/bid-sections` | 多标段探测 | out `{hasMultiple,totalDeclared}` | `:92` |

### 3.4 tasks（**P**）

| # | 方法 | 路径 | 作用 | 证据 |
|---|---|---|---|---|
| 30-38 | POST | `/tasks/start-bid-section-extraction`、`start-bid-analysis`、`start-outline-generation`、`start-global-facts-generation`、`start-content-generation`、`start-rejection-items-extraction`、`start-rejection-check`、`start-duplicate-analysis`、`start-response-deviation-generation` | 启动长任务，返回 `BackgroundTaskState`；未注册 runner → 501，其它冲突 → 409 `{error}` | `routes/tasks.ts:29-37` |
| 39 | POST | `/tasks/pause-content-generation` | 暂停正文（`pausing`→`paused`） | `:39-46` |
| 40 | GET | `/tasks/active` | 当前活跃任务数组（触发崩溃恢复） | `:48` |

### 3.5 rejection-check（**P** + M(bid-check)）

| # | 方法 | 路径 | 作用 | 入参 | 证据 |
|---|---|---|---|---|---|
| 41 | GET | `/rejection-check/state` | 全量工作区 | — | `routes/rejection-check.ts:18` |
| 42 | POST | `/rejection-check/remove-document` | 移除招标/投标文档 | `{role:'tender'|'bid',documentId?}` | `:21-24` |
| 43 | POST | `/rejection-check/ui-state`、`/update` | 存 UI 状态 / 局部更新（任务引擎流式写） | `{step?,activeDocumentTab?,activeResultTab?,activeCheckResultTab?,customCheckItems?,checkOptions?}` / `partial` | `:27,30` |
| 45 | POST | `/rejection-check/clear` | 清空 | — → `{success,message,state}` | `:33` |
| 46 | POST | `/rejection-check/import-document?role=tender|bid` | multipart 导入 | `files[]` | `:37-48` |
| 47 | POST | `/rejection-check/import-tender-from-technical-plan` | 跨域复用技术方案招标原文 | — | `:52-54` |

### 3.6 duplicate-check（**P** + M(bid-check)）

| # | 方法 | 路径 | 作用 | 入参 | 证据 |
|---|---|---|---|---|---|
| 48 | GET | `/duplicate-check/state` | 全量工作区 | — | `routes/duplicate-check.ts:44` |
| 49 | POST | `/duplicate-check/files` | 存文件集 | `{tenderFile?,tenderFiles?,bidFiles?,step?,activeAnalysisTab?}` | `:47` |
| 50 | POST | `/duplicate-check/ui-state`、`/update` | 存 UI 状态 / 局部更新 | `{step?,activeAnalysisTab?}` / `partial` | `:50,53` |
| 52 | POST | `/duplicate-check/clear` | 清空 | — → `{success,message,state}` | `:56` |
| 53 | POST | `/duplicate-check/select-files` | multipart 落盘（sha1 命名），返回 `LocalFileSelection[]` | `files[]` | `:61-79` |

### 3.7 response-deviation（**P**）

| # | 方法 | 路径 | 作用 | 入参/出参 | 证据 |
|---|---|---|---|---|---|
| 54 | GET | `/response-deviation/availability` | 可用性探测 + 源变更置 `stale` | out `{available,reason,kind,templateTitle,sourceChapterTitle,tenderHash,selectedSectionId,workspaceExists,workspaceStatus}` | `routes/response-deviation.ts:45-54` |
| 55 | GET | `/response-deviation` | 工作区（含 `rows[]`） | | `:56` |
| 56 | POST | `/response-deviation/generate` | 生成（幂等复用） | in `{force?}`；out `{reused:true,workspace}` 或 `{reused:false,task}` | `:58-70` |
| 57 | PATCH | `/response-deviation/project-fields` | 改项目字段（带 evidence 结构） | `ResponseDeviationProjectFields` | `:72` |
| 58 | PATCH | `/response-deviation/rows/:rowId` | 改单行，白名单 `responseText/deviationStatus/deviationExplanation/notes`，置 `manualEdited` | | `:74-81`、`store.ts:169-176` |
| 59 | POST | `/response-deviation/confirm` | 确认工作区（有未覆盖/重复引用则 409） | — | `:83`、`store.ts:189-200` |
| 60 | GET | `/response-deviation/source/:rowId` | 单行招标原文+证据 | | `:85-98` |
| 61 | GET | `/response-deviation/export-validation` | 导出前置校验（error/warning 列表） | out `{status,issues[],columns,summary}` | `:100-103` |
| 62 | POST | `/response-deviation/export` | 导出 docx（前置校验 error 会抛 409） | → `application/vnd...wordprocessingml.document` | `:105-117`、`response-deviation/export.ts:451-452` |

### 3.8 knowledge-base（M(knowledge-base)，非项目域）

| # | 方法 | 路径 | 作用 | 证据 |
|---|---|---|---|---|
| 63 | GET | `/knowledge-base` | `{folders,documents}`（先恢复中断文档） | `routes/knowledge-base.ts:37` |
| 64 | POST/PATCH | `/knowledge-base/folders`、`/folders/:folderId` | 建 / 改名 `{name}` | `:40,43-46` |
| 66 | POST | `/knowledge-base/folders/reorder` | 拖拽排序 `{draggedFolderId,targetFolderId,position}` | `:49-56` |
| 67 | DELETE | `/knowledge-base/folders/:folderId`、`/documents/:documentId` | 删文件夹 / 文档（均级联子表） | `:59-68` |
| 69 | POST | `/knowledge-base/documents/move` | 移动文档 `{documentId,targetFolderId,targetDocumentId?,position?}` | `:71-79` |
| 70 | GET | `/knowledge-base/documents/:documentId/markdown` | 原文 markdown | `:82-85` |
| 71 | GET | `/knowledge-base/documents/:documentId/items` | 抽取后的 `KnowledgeItem[]` | `:88-91` |
| 72 | GET | `/knowledge-base/documents/:documentId/analysis` | 处理分析快照（blocks/报告/丢弃组） | `:94-97` |
| 73 | POST | `/knowledge-base/outline-references` | `{documentIds}` → 可注入目录的知识条目（被技术方案消费） | `:100` |
| 74 | GET | `/knowledge-base/migration-status` | 迁移状态（Web 恒 `needsMigration:false`） | `:103` |
| 75 | POST | `/knowledge-base/folders/:folderId/documents/upload` | multipart 上传；立即返回 `{success,message,documents}`，解析+抽取 fire-and-forget，进度走 SSE `kb-document`。**BidCore 映射**：`POST /api/knowledge/upload`（每文件建素材）与 `POST /api/knowledge/:id/files`（追加到既有素材），同步解析后返回 `{documents,failed}` / `{document,added}`；未实现 folderId 与 SSE 进度 | `:110-149` |
| 76 | POST | `/knowledge-base/documents/:documentId/retry` | 重试抽取。**BidCore 映射**：`POST /api/knowledge/:id/reparse`，按磁盘上全部附件重建正文 | `:170` |
| 77 | POST | `/knowledge-base/documents/:documentId/match` | 条目↔块匹配 | `:184` |

### 3.9 asset-library（M(knowledge-base)；`library ∈ tool|company`）

| # | 方法 | 路径 | 作用 | 证据 |
|---|---|---|---|---|
| 78 | GET | `/asset-library/:library?q=&expiry=` | 列表 + `counts` | `routes/asset-library.ts:37-46` |
| 79 | POST | `/asset-library/:library` | multipart 新建（`name/notes/expiryDate/tags/files[]`） | `:49-68` |
| 80 | GET/PATCH | `/asset-library/:library/:id` | 详情 / multipart 更新（含 `removeFileIds`） | `:71-111` |
| 82 | DELETE | `/asset-library/:library/:id` | 删除 | `:114-120` |
| 83 | GET | `/asset-library/:library/:id/files/:fileId?download=1` | 文件流（Bearer 鉴权） | `:123-145` |
| 84 | GET | `/asset-library/expiring?withinDays=30` | 跨库到期聚合（仪表盘） | `:148-153` |

### 3.10 personnel（M(knowledge-base)；一人多证）

| # | 方法 | 路径 | 作用 | 证据 |
|---|---|---|---|---|
| 85 | GET | `/personnel?q=&expiry=` | 列表 + `counts` | `routes/personnel.ts:22-29` |
| 86 | GET | `/personnel/expiring?withinDays=30` | 到期聚合（必须先于 `:id` 注册） | `:32-37` |
| 87 | POST | `/personnel` | multipart 新建 `{name,department,position,phone,notes,tags}` → `{profile}` | `:40-53` |
| 88 | GET/PATCH/DELETE | `/personnel/:id` | 详情 / 更新（multipart）/ 删除 → `{success,profile?}` | `:56-85` |
| 89 | POST/PATCH/DELETE | `/personnel/:id/certificates[/:certId]` | 证书增改删（multipart：`certName/certType/expiryDate/obtainedAt/notes/removeFileIds/files[]`）→ `{certificate,profile}` | `:88-144` |
| 90 | GET | `/personnel/:id/certificates/:certId/files/:fileId` | 证书文件流（`?download=1` 附件） | `:147-166` |

### 3.11 templates（M(template-settings)）

| # | 方法 | 路径 | 作用 | 证据 |
|---|---|---|---|---|
| 92 | GET | `/templates`、`/templates/:id` | 列表（自己+共享；admin 全量）/ 单个（null=不存在或无权） | `routes/templates.ts:22-29` |
| 94 | POST | `/templates` | 新建（body=模板 config，可带 `is_shared`） | `:31-36` |
| 95 | PUT | `/templates/:id` | 更新 | `:38-43` |
| 96 | DELETE | `/templates/:id` | 删除 | `:45-48` |
| 97 | PATCH | `/templates/:id/share` | 共享开关（**A**） | `:50-67` |

### 3.12 export / events

| # | 方法 | 路径 | 作用 | 关键契约 | 证据 |
|---|---|---|---|---|---|
| 98 | POST | `/export/word` | **P**；渲染 docx 并流回，`bodyLimit 50MB`，`timeout` 前端 300s | in `{requestId?,project_name?,outline[],export_format?,base_dir?}`；`project_code` 由服务端补 | `routes/export.ts:22-90`、`export/format.ts:147-157` |
| 99 | GET | `/events?projectId=n` | **P**（自行校验归属）；SSE 多路复用 | `event:`=channel；25s `: ping` | `routes/events.ts:21-86` |

### 3.13 config / system-settings

| # | 方法 | 路径 | 作用 | 证据 |
|---|---|---|---|---|
| 100 | GET | `/config` | 合并 `AppConfig+UserConfig` 并归一化；非 admin 脱敏 key | `routes/config.ts:13-19` |
| 101 | PUT | `/config`、`/config/user` | **A** 写平台配置（空 key 不覆盖）/ 任意用户写个人偏好白名单 | `:21-35` |
| 103 | GET/PUT | `/system-settings` | 公开读系统名称+Logo（登录页用）/ **A** 写 `{systemName?,logoDataUrl?}` | `routes/system-settings.ts:11-31` |

### 3.14 agent / ai

| # | 方法 | 路径 | 作用 | 证据 |
|---|---|---|---|---|
| 105 | GET/POST | `/agent/status`、`/agent/self-check`、`/agent/restart` | 状态（登录可读）/ 自检 **A** / 重启 **A** | `routes/agent.ts:33-74` |
| 108 | GET | `/agent/pending-question` | 当前挂起提问（按项目归属过滤） | `:79-85` |
| 109 | POST | `/agent/answer` | 作答 `{question_id,option_id,custom_answer?}`；失效→409 | `:87-122` |
| 110 | POST | `/ai/chat`、`/ai/request-json` | 文本对话 → `{content}` / JSON 结构化（重试+修复）→ `{result}`（key 不下发浏览器） | `routes/ai.ts:38-60` |
| 112 | POST | `/ai/list-models`、`/ai/test-image-model` | 拉模型列表（可带表单 config 覆盖）/ 生图连通性测试（不落盘） | `:62-85` |

### 3.15 users（**A**）/ prompts

| # | 方法 | 路径 | 作用 | 证据 |
|---|---|---|---|---|
| 114 | GET | `/users?status=` | 列表 + `pendingCount` | `routes/users.ts:29-44` |
| 115 | POST | `/users/:id/approve`、`/disable`、`/enable` | pending→active / 停用 / 启用（不能停用自己） | `:49-78` |
| 117 | PUT | `/users/:id` | 改姓名/部门/角色/模块/重置密码（手机号不可改） | `:81-120` |
| 118 | DELETE | `/users/:id` | 删除 | `:121-129` |
| 119 | GET | `/prompts?runnerKey=` | 目录（不含 `promptText`；登录可读） | `routes/prompts.ts:33-40` |
| 120 | GET/POST/PUT/DELETE | `/prompts/:id`、`/prompts` | 单条（含 `promptText`，**A**）/ 新建 / 更新 / 删除（内置项不可物理删除） | `:49-124` |
| 122 | POST | `/prompts/:id/reset`、`/prompts/reset-all` | 重置为内置 | `:125-144` |

### 3.16 documents

| # | 方法 | 路径 | 作用 | 证据 |
|---|---|---|---|---|
| 123 | GET | `/documents/supported-extensions` | 支持扩展名 | `routes/documents.ts:17-19` |
| 124 | POST | `/documents/parse` | multipart 单文件→markdown（不落盘不写库） | `:23-59` |

> 另有 3 个未在任务清单要求但真实存在的域：`docs/*`（站内文档 CRUD，`routes/docs.ts:30-130`）、`feedback/*`（FAQ 反馈问答，`routes/feedback.ts:23-118`）、`ai-diagnostics/*`（**A**，`ai-diagnostics/routes.ts`）。

---

## 4. 数据模型（Prisma 提炼）

| 分组 | 表 | 关键列（只列契约相关） | 说明 |
|---|---|---|---|
| 身份 | `users` | `username@unique`(手机号), `password`, `role`, `status(pending/active/disabled)`, `mustChangePassword`, `modules`(JSON 字符串数组) | `schema.prisma:12-35` |
| 项目 | `projects` | `projectCode@unique`, `name`, `bidderName`, `subjectReplacements`(JSON), `ownerId`, `status`, `lastExportedAt` | `:38-54`；`lastExportedAt` 供仪表盘"正文完成+导出过=100%"判定 |
| 配置 | `app_config`(单行 id=1, Json data)、`user_configs`(userId, Json data) | | `:57-73` |
| 模板 | `export_templates` | `templateId@id`, `userId`, `templateName`, `config`(Json), `isShared` | `:79-92` |
| 技术方案 | `technical_plan_meta` (PK projectId) | `workflowKind`, `step`, `tenderFileName/Path/Hash/Chars`, `tenderFilesJson`, `originalPlan*`, `pendingTender*`(多标段待确认), `bidAnalysisMode`, `bidAnalysisSelectedTaskIdsJson`, `bidSectionMode`, `bidSectionsJson`, `outlineMode`, `outlineExpansionMode`, `mirrorProcurementEnabled`, `outlineWordControl*`, `contentGeneration*Json`, `contentIllustrationPlanJson`, `selectedSection*` | `:154-203`；几乎所有标量都以 String/Json 存，时间戳是 ISO 字符串 |
| | `technical_plan_tasks` (PK projectId+type) | `taskId`, `status`, `progress`, `logsJson`, `statsJson`, `error`, `pauseRequested` | `:206-222` 每项目每类型一行（对齐任务单例） |
| | `technical_plan_bid_items` (PK projectId+itemId) | `label`, `status`, `content`, `error`, `sortOrder` | `:226-241` = `bidAnalysisTasks` |
| | `technical_plan_reference_docs` (PK projectId+documentId) | `sortOrder` | `:245-255` = `referenceKnowledgeDocumentIds` |
| | `technical_plan_outline_nodes` (PK projectId+nodeId) | `parentNodeId`, `sortOrder`, `level`, `title`, `description`, `sourceRequirement*`, `knowledgeItemIdsJson`, **`content`**, `isMirror`, `mirrorSourceText`, `outlineAttribute`, `contentMode`, `contentModeNote` | `:259-285`；正文就存在节点上 |
| | `technical_plan_content_sections` (PK projectId+nodeId) | `status`, `error` | `:288-300` |
| | `technical_plan_content_plans` (PK projectId+nodeId) | `planJson` | `:303-313` |
| | `technical_plan_global_fact_groups` (PK projectId+groupId) | `title`, `content`, `sortOrder` | `:317-331` |
| 知识库（公司共享，无 userId） | `knowledge_folders` | `folderId@id`, `name`, `sortOrder` | `:354-363` |
| | `knowledge_documents` | `documentId@id`, `folderId`, `fileName`, `markdownPath`, `markdownChars`, **`status`**, `progress`, `message`, `itemCount`, `blockCount`, `*Count` 统计, `parserLabel` | `:366-395` |
| | `knowledge_blocks` | `(documentId,blockId,isFiltered)@unique`, `headingPathJson`, `content`, `filterReason` | `:398-414` |
| | `knowledge_candidate_items` / `knowledge_items` | `(documentId,itemId)@unique`, `title`, `summary|resume`, `content`, `contentChars` | `:417-451` |
| | `knowledge_item_blocks` | `(documentId,itemId,blockId)@unique` | `:454-465` |
| | `knowledge_discarded_groups` / `knowledge_reports` / `knowledge_document_steps` / `knowledge_match_batches` | 丢弃原因、覆盖率报告、9 步状态、匹配批次 | `:468-531` |
| 资质/人员 | `asset_items` | `id@id(cuid)`, `library(tool/company)`, `name`, `notes`, `files`(Json `[{fileId,originalName,mimeType,size,ext}]`), `expiryDate?`, `tags[]` | `:539-553` |
| | `personnel_profiles` / `personnel_certificates` | profile: `name/department/position/phone/tags`；cert: `certName/certType/files/expiryDate/obtainedAt` | `:561-591` |
| 查重（14 表） | `duplicate_check_meta` | `step`, `activeAnalysisTab`, `currentSignature` | `:598-608` |
| | `duplicate_check_files` / `_tasks` / `_analysis_sections`（section ∈ metadata/outline/content/image） | 文件角色、任务与分区进度 | `:611-665` |
| | `_content_files` / `_metadata_items` / `_outline_items` / `_outline_groups` / `_outline_pairwise` / `_content_duplicates` / `_content_occurrences` / `_image_files` / `_duplicate_images` / `_image_occurrences` | 元数据项、目录树+两两相似度、重复句/出现位置、重复图/位置 | `:668-844` |
| 废标检查（8 表） | `rejection_check_meta` / `_documents` / `_tasks` / `_extraction` / `_results`（resultType） / `_risk_findings` / `_typo_findings` / `_logic_findings` | 文档角色 tender/bid-N、抽取文本、三类结果 | `:851-1001` |
| 偏离表 | `response_deviation_workspaces` (PK projectId) | `status(empty/detecting/review/confirmed/stale/failed)`, `tenderHash`, `selectedSection*`, `templateTitle/Kind/SchemaJson`, `projectFieldsJson`, `statsJson`, `confirmedAt` | `:1082-1104` |
| | `response_deviation_rows` | `sequenceNo`, `clauseNo`, `requirementMarkdown/PlainText`, `sourceEvidenceJson`, `sourceFingerprint`, `aggregation`, `confidence`, `responseText`, `deviationStatus/Explanation`, `notes`, `manualEdited` | `:1106-1131` |
| Prompt | `prompt_templates` | `(runnerKey,itemKey)@unique`, `label`, `output(markdown|json)`, `required`, `promptText`, `enabled`, `builtin`, `isSystem` | `:1009-1029` |
| 文档/反馈/诊断 | `docs_articles`、`feedbacks`/`feedback_replies`、`ai_diagnostic_runs`/`ai_diagnostic_attempts` | | `:95-144`、`:1031-1080` |

**建模要点**：项目域全表以 `projectId` 分区（复合主键/索引），共享域（知识库/资产/人员/prompt）无 userId；时间列多为 `String`(ISO) 以保持字典序=时间序（`schema.prisma:146-151` 注释）。

---

## 5. 人机协作现状（可复用为 HITL 审核节点）

| # | 现有机制 | 契约/状态 | 可复用为 | 证据 |
|---|---|---|---|---|
| 1 | **Agent ask-user 提问** | 服务端 `requestQuestion({task_id,task_title,project_id,question,options[],metadata?})` 挂起 Promise → SSE `agent-question` → 前端 `GET /agent/pending-question` 兜底 → `POST /agent/answer {question_id,option_id,custom_answer?}` resolve；`option.custom=true` 支持"需输入具体要求" | 通用审批弹窗（任意步骤的"继续/调整/放弃"） | `agent/types.ts:193-239`、`piRuntimeService.ts:900-1050`、`routes/agent.ts:79-122`、`index.ts:79-83` |
| 2 | **目录策略确认（STEP03）** | 检测到招标"技术/响应方案"章节 `explicit_checklist≥2 项` 时，弹 `step03-proposal-structure-*` 提问：`recommended`（评分表作一级/清单并入二三级）或 `defer`（抛错暂停，不烧额度）；Agent 不可用则记日志按推荐继续 | 生成前的"策略确认"节点（含成本闸） | `tasks/runners/outline-generation.ts:144-194` |
| 3 | **偏离表 review → confirm** | 状态机 `empty→detecting→review→confirmed`，源哈希/标段变化→`stale`；`confirm` 前拒收：`stats.uncoveredBlockIds`/`duplicateBlockIds` 非空；行级编辑置 `manualEdited`；导出按钮硬门禁 `status==='confirmed' && validation.status!=='error'` | 标准"AI 产出 → 人工批注 → 确认"三段式；可抽成通用 review workspace | `response-deviation/store.ts:189-210`、`routes/response-deviation.ts:83`、`ResponseDeviationWorkbenchPage.tsx:283` |
| 4 | **导出前置校验** | ① 技术方案导出：`outline` 为空直接 400（服务端二次校验）；② 偏离表：`validateResponseDeviationExport` 产出 `error/warning`（列数不足、缺"响应与偏离"列、包号冲突、HTML 残留、空要求、条目号混入正文…），`error` 阻断导出；③ 前端导出前 toast 门禁 | 通用"发布前 lint"：可配置规则集 + 分级（阻断/警告） | `export/service.ts:31-35`、`routes/export.ts:68-76`、`response-deviation/export.ts:361-428,451-452` |
| 5 | **正文生成暂停/续跑** | `pause-content-generation` → `pause_requested` + `pausing`；runner 在 AI 请求间隙轮询 `isPauseRequested()`；`start-content-generation {resume:true}` 续跑（暂停中只允许 resume） | 长任务的"人工介入"控制面 | `tasks/service.ts:431-443,717-730,379-391` |
| 6 | 管理类审批 | 用户注册 `pending→active`；prompt 内置项只可改文案/开关、不可物理删除；导出模板共享仅 admin | 后台治理台 | `routes/users.ts:49-56`、`routes/prompts.ts:84-124`、`routes/templates.ts:50-67` |

> 结论：仓库里**没有**通用 workflow/HITL 引擎，只有"任务 + 事件 + 域内确认"三件套。重写时建议把 #1 抽象为 `hitl.request/answer` 服务（承接 SSE + 轮询 + 超时降级），#2/#3/#4 作为该服务的三种 `kind`。

---

## 6. 重写建议（能力 → 取舍）

| 能力 | 原仓库位置 | 判断 | 目标形态 | 接口兼容 | workflow 化 |
|---|---|---|---|---|---|
| 项目 CRUD + 激活 + 删除级联 | `routes/projects.ts` | 保留 | REST 保留；删除改为"软删+后台清理" | 兼容（`projectCode` 服务端生成、`progress/isComplete` 计算字段保留） | 否 |
| 技术方案全量状态 RPC | `routes/technical-plan.ts` + `store.ts` | 保留（关键） | **必须接口级兼容**：`GET /state` 整棵返回；写路由回整棵；`select-bid-section`/`clear` 双层 envelope | **必须兼容** | 否（但需把 `updateTechnicalPlan(partial)` 变成唯一写入口，勿拆散） |
| 技术方案 6 步 UI 状态机 | `TechnicalPlanHome.tsx:46-62,314-338` | 保留 | 步骤+门禁表驱动，避免散落 if | 前端内部契约 | 可 workflow 化（step 枚举 + guard 表） |
| 9 个 `tasks/start-*` | `routes/tasks.ts`、`service.ts:686-748` | 保留（关键） | **必须接口级兼容**：同路径、同 snake_case payload、同 `BackgroundTaskState` 返回 | **必须兼容** | 是：抽 `TaskEngine`（组锁/payload 签名/暂停/崩溃恢复/SSE 广播） |
| 正文生成子流水线 | `runners/content-generation.ts`（198KB） | 保留但拆分 | 拆 `plan → generate → audit → repair → illustration` 独立阶段服务，`stats.content.phase` 不变 | `tasks` 事件里 `stats` 形状兼容 | 是（阶段状态机 + 断点续跑） |
| SSE 总线 | `events/bus.ts`、`routes/events.ts`、`sse.ts` | 保留（关键） | **必须接口级兼容**：`/events?projectId=`、`event:`=channel、5 个 channel 名、`data` JSON | **必须兼容** | 否（横向扩展时换 Redis/Postgres NOTIFY，帧格式不变） |
| Word 导出 | `routes/export.ts`、`export/docxBuilder.ts`(82KB) | 保留 | **必须兼容** payload 与 `Content-Disposition`；`project_code` 服务端补 | **必须兼容** | 可（导出作业化：返回 jobId+进度，但保留同步接口） |
| 偏离表 | `response-deviation/*` | 保留并升级 | 把 `review/confirm/validation` 做成一等审核工作流；行级 diff/批量填充 | 兼容（`status` 枚举、`rows[]` 字段、`availability`） | 是（detect→review→confirm→export） |
| 查重 / 废标检查 | `duplicate-check/*`、`rejection-check/*` | 保留 | 统一"分析分区"模型（metadata/outline/content/image；rejection/typo/logic），状态 `state` RPC 兼容 | 兼容（`/state`、`/update`、`/ui-state`、`/clear`） | 是（分析分区独立可重跑） |
| 知识库四库 | `knowledge-base/*`、`asset-library/*`、`personnel/*` | 保留 | 统一资源服务（folder/document/item/cert），但**保留** `POST /knowledge-base/outline-references`（技术方案强依赖）与 `GET /asset-library/expiring`、`GET /personnel/expiring` | 部分兼容（outline-references + 到期聚合必须兼容） | 知识抽取可 workflow 化（9 步 + 匹配批次） |
| Prompt 管理 | `routes/prompts.ts`、`prompts/store.ts` | 保留 | DB 驱动 + 硬编码兜底不变；增加版本/发布审批/回滚 | 兼容（`runnerKey/itemKey/output/required`） | 可（草稿→发布） |
| AI 代理 | `routes/ai.ts`、`ai/service.ts` | 保留 | 统一网关 + 队列 + 重试 + 诊断；key 永不下发 | 兼容（`/ai/*` 4 条；上游错误映射 502 不可改，否则前端会误登出） | 否 |
| Agent sidecar | `agent/*` | 保留但解耦 | 把 `requestQuestion/answerQuestion` 提炼为通用 HITL 服务；sidecar 仅作为 runner 之一 | `agent-question` 事件与 `/agent/answer` 兼容 | 是（HITL 节点） |
| 模板/排版 | `templates/*`、`export-format/*` | 保留 | `config` 仍是自由 Json blob（前端 7 页签），服务端按结构读、缺字段走默认 | 兼容（blob + `is_shared`） | 否 |
| 用户/权限 | `routes/users.ts`、`auth/*`、`permissions.ts` | 保留 | 可换 OIDC/SSO，但保留 `role`、`modules[]`、`mustChangePassword` 语义 | `/me` 形状必须兼容（前端权限判定依赖） | 否 |
| 诊断/文档/FAQ/开发页 | `ai-diagnostics/*`、`docs/*`、`feedback/*`、`features/developer/*` | 可重设计 | 诊断保留（可观测底座）；开发页不进正式版 | 不承诺 | 否 |

**必须接口级兼容（硬清单）**：`GET /technical-plan/state` 及全部 `/technical-plan/*` 写路由、9 个 `/tasks/start-*`、`/tasks/pause-content-generation`、`/tasks/active`、`POST /export/word`、`GET /events`（channel/帧格式）、`POST /knowledge-base/outline-references`、`GET /me`。

**可以重设计（软清单）**：`/agent/self-check|restart`、`/prompts/*` 写操作、`/users/*`、`/config*`、`/system-settings`、`/templates/*`、`/documents/parse`、`/asset-library/*`（可改 JSON+预签名 URL，保留 multipart 兼容层）、`/knowledge-base` 文件夹排序/移动、`/docs/*`、`/feedback/*`、`/ai-diagnostics/*`。

---

## 7. SSE 事件形状

### 7.1 连接与帧格式

```
GET /api/events?projectId=<n>        Authorization: Bearer <jwt>
响应头：Content-Type: text/event-stream; charset=utf-8
        Cache-Control: no-cache, no-transform / Connection: keep-alive
        X-Accel-Buffering: no / Access-Control-Allow-*（hijack 后手写）
首帧：`: connected\n\n`        心跳：`: ping <epochMs>\n\n`（25s）
事件帧：`id: <单调递增>\nevent: <channel>\ndata: <JSON>\n\n`
```

证据：`routes/events.ts:43-80`（hijack、CORS 手写、25s 心跳、`id/event/data` 帧）、`events/bus.ts:20-25,50-61`（进程内 pub/sub，按 projectId 隔离，`id` 单调递增供 `Last-Event-ID`）。客户端用 `@microsoft/fetch-event-source` 带 Bearer、`openWhenHidden:true`、401 时抛 `FatalSseError` 停止重连（`client/src/shared/api/sse.ts:67-123`）。

### 7.2 五个 channel

| channel | 触发点 | `data` 形状 | 证据 |
|---|---|---|---|
| `tasks` | 任务引擎每次 `updateTask(shouldPersist=true)` | `{ task: BackgroundTaskState, technicalPlanPatch?: {...}, bidItem?, outlineData?, contentSection?, contentPlan?, contentRuntime?, rejectionCheck?, duplicateCheck?, responseDeviation? }`（按任务 `stateKey` 只填其一） | `bus.ts:14`、`tasks/types.ts:71-85`、`service.ts:214-221,348-351` |
| `kb-document` | 知识库文档每次状态变更 | `{ document: DocumentDto }`（`status/progress/message/error/itemCount/...`） | `bus.ts:15`、`knowledge-base/extraction.ts:84-94` |
| `ai-http-error` | 上游返回 HTML/异常响应（需弹窗给用户看原文） | `{ status, statusText, contentType, body, source, createdAt }` | `bus.ts:16`、`ai/httpError.ts:7-14,117` |
| `export-progress` | Word 导出进度 | `{ requestId, phase:'running'|'completed'|'error', progress, message, warnings[] }` | `bus.ts:17`、`routes/export.ts:57-66,74` |
| `agent-question` | pi ask-user 提问/清除 | `AgentPendingQuestion`：`{ question_id, task_id, task_title?, project_id?, question, options:[{id,label,description?,recommended?,custom?}], metadata?, asked_at }` | `bus.ts:18`、`agent/types.ts:203-214`、`index.ts:79-83` |

### 7.3 `tasks` 帧示例（正文生成中）

```json
{ "task": { "task_id":"ct-1731...", "type":"content-generation", "status":"running", "progress":42, "pause_requested":false,
            "stats": { "content": { "phase":"generating", "generation_total":12, "generation_completed":3 } } },
  "technicalPlanPatch": { "contentGenerationSections": { "node-3": { "status":"success" } } },
  "contentSection": { "nodeId":"node-3", "status":"success", "content":"..." } }
```

> 重写注意：客户端是"**按 patch 合并 + 按 section 覆盖**"消费的（`client/src/shared/api/bridge.ts` 的 `tasks.onTaskEvent` 分发），因此 `technicalPlanPatch` 必须是**部分字段**，不要改成整棵 state，否则前端会闪烁/丢未提交编辑。

---

## 8. 附录：重写时的最小落地顺序

1. 身份 + 项目 + `X-Project-Id` 中间件 + `/events` 骨架（无业务也能跑通 SSE 心跳）。
2. `technical-plan/state` 读写 + `technical_plan_*` 7 张表（先把 state 形状冻结）。
3. `TaskEngine`（组锁、payload 签名、日志/进度、崩溃恢复、SSE 广播）+ 9 个 start 路由（runner 可先留空返回 501，验证 409/501 分支）。
4. `outline-generation` + `bid-analysis` + `content-generation` 三个 runner（覆盖 90% 体验）。
5. 知识库 + `outline-references`（目录/正文质量来源）→ 偏离表（review/confirm/validation 直接当 HITL 模板）→ 查重/废标（`state/update/ui-state` 批量复制）→ 导出（docxBuilder 是最大移植成本，保持同步接口 + SSE 进度）。
