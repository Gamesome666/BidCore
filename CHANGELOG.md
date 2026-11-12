# 更新日志

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中

- 并签审核（`parallel` 策略）真正并行决策，当前仅按 `level + 1` 串行
- Prompt 管理页；知识库文件上传与预签名 URL
- 正文生成的真断点续跑（当前"暂停/续跑"只改兼容层任务状态）
- SLA 到期升级的公开验证入口（现在只能改库或等真实到期）

---

## [1.0.0] — 2026-11-13

首个公开版本：可人工干预的 Multi-Agent 投标标书平台，零 npm 依赖、零构建、断网可跑。

### 新增 · 工作流引擎

- Supervisor 动态规划 → 7 条计划校验 → `FallbackPlan` 兜底（11 节点确定性 DAG），模型输出异常不中断运行
- 节点状态机 + 租约 + 版本化产物（`active` / `frozen` / `superseded`）+ 失效传播 + 崩溃恢复（`run.recovered`）
- `human-review` 作为一等节点类型：命中即挂起 `waiting_human`、生成审核任务、SSE 推送
- 预算闸门与并行批次调度；Supervisor 决策流可审计（含返工决策）

### 新增 · Self-Loop 质量闭环

- 14 条确定性规则 + 5 维度加权（完整性 30 / 准确性 25 / 技术性 20 / 匹配度 15 / 规范性 10）
- 双轨封顶：规则分与 LLM 评委分各自封顶，`cap_share` 把评委影响限制在 15.5%
- 分数不达标 → 按「缺陷码 → 目标 Agent」确定性返工 → 目标重跑 → 失效传播 → 二次评估
- 3 轮不达标或命中废标项 → 熔断转人工；人工可"接受当前质量"（只签字、不改分，可审计）

### 新增 · HITL 审核中心

- 统一审核包：产物 + 质量 + 规则证据 + 版本 diff + 上游意见 + 级别进度 + SLA
- 四动作：通过 / 驳回 / 修改 / 要求重新分析；驳回与修改只能选祖先目标（非祖先 → `409 REVIEW_TARGET_NOT_ANCESTOR`）
- `commandId` 幂等 + `version` 乐观锁（重复决策 → `409 REVIEW_ALREADY_DECIDED`）
- 三级审核策略、SLA 提醒与超时升级、评论线程、admin 转派、审核历史

### 新增 · 技术方案流水线

- 七步：解析招标文件 → 目录 → 事实 → 正文 → 检查 → 导出，每步可单独重跑
- 响应偏离表：生成 / 行内编辑 / 确认，**确认是导出硬门禁**，编辑自动撤销确认
- 废标项检查、查重（元数据/目录/正文维度）、Word 导出（docx，含校验）

### 新增 · 兼容层

- `/api/technical-plan`、`/api/tasks/start-*`（9 个入口）、`/api/export/docx`、`/api/events`（SSE）
- 旧客户端的最小可用路径，语义与信息架构对齐参考实现

### 新增 · 前端

- 零构建 SPA：原生 ES Module + hash 路由，无打包器、无框架
- 14 个页面：总览 / 项目 / 工作台（7 tab）/ 运行 / 审核中心 / 质量 / 知识库 / Agent / 编排 / 设置 / 用户 / 关于
- SSE 4 频道实时刷新，断线自动重连

### 新增 · 数据与运维

- 19 张 SQLite 表（WAL），`node:sqlite` 单文件库，无需数据库服务
- `node server/reset.mjs` 重置演示数据；`node tools/demo.mjs` 生成幂等演示状态
- `node tools/shot.mjs` headless 截图；`node tools/probe-llm.mjs` 探活模型网关

### 变更

- 相对基线 `bidflow`：一体化工作流引擎取代散落的任务入口；质量分驱动返工；审核中心统一多级/幂等/转派

### 已知问题

- 冒烟 42 通过 / 0 失败 / 1 跳过：SLA 到期升级无法用公开接口提前 `sla_due_at`
- LLM 评委当前为确定性 rubric，`judge.model` 仅作配置位
