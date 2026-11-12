# 贡献指南

感谢你愿意改进 BidCore。本项目刻意保持**小而可读**：无 npm 依赖、无构建步骤、无数据库服务。
请在动手前花 3 分钟读完本页。

---

## 1. 环境

| 项 | 要求 |
|---|---|
| Node.js | **≥ 22.13**（推荐 24.x；`node:sqlite` 在 24.x 无需实验性开关） |
| 包管理器 | 不需要。`npm install` 装了也全是空的（零依赖） |
| 数据库 | 不需要。首次启动自动建 `var/bidcore.db`（SQLite，WAL） |
| 模型 | 可选。不配 `.env` 时自动使用**确定性 Mock 写作器**，断网可跑全链路 |

```bash
git clone <your-fork-url> && cd bidcore
node server/index.mjs        # → http://127.0.0.1:5192，登录 admin / admin123
```

如果只想换端口跑一份干净数据：

```bash
PORT=5197 BIDCORE_DB=$PWD/var/scratch.db node server/index.mjs
```

## 2. 目录职责

```
server/
  index.mjs      入口：HTTP 服务、静态资源、后台循环
  api.mjs        路由表（把请求派给 routes/*）
  db.mjs         node:sqlite 建表 + DAO
  seed.mjs       种子数据（5 账号 / 2 项目 / 知识库 / 编排模板）
  smoke.mjs      端到端冒烟：唯一"测试套件"，改动必须让它继续全绿
  routes/        HTTP 层：只做参数校验 + 权限 + 调 domain
  domain/        业务：engine（工作流）/ review（HITL）/ quality（Self-Loop）/ tasks / bid / docx / llm …
  lib/           http / env / bus / util / loops（无业务语义）
web/             零构建 SPA：原生 ES Module + hash 路由，无打包器
tools/           demo.mjs（造演示数据）/ shot.mjs（headless 截图）/ probe-llm.mjs（探活模型）
docs/            DEMO.md（演示脚本）/ PARITY-yibiao.md（对标分析）/ shots（界面截图）
```

**分层规矩**：`routes/` 不写业务逻辑，`domain/` 不碰 `req/res`，`lib/` 保持无业务语义
（唯一例外是 `lib/loops.mjs`，后台循环需要 import `domain/`；新增代码不要扩大这个例外）。

## 3. 提交前必须做

```bash
node --check server/index.mjs       # 改到哪个文件就 check 哪个；CI 会全量 check

PORT=5197 node server/index.mjs &   # 另开一个终端
BIDCORE_BASE=http://127.0.0.1:5197 node server/smoke.mjs
```

**验收基线：`42 通过 / 0 失败 / 1 跳过`。** 新增能力请顺手在 `server/smoke.mjs` 里补一条用例，
位置按现有分组（认证 → 项目 → 技术方案 → 工作流 → 审核 → 质量 → 兼容层 → 权限）。

跳过项必须**写出为什么跳过后仍然可信**（参考现有 SLA 升级用例的写法）。

## 4. 代码风格

- 纯 ESM（`import`/`export`），不加 `"use strict"`，不用 CommonJS；
- **不引入 npm 依赖**。需要的能力优先用 Node 内置（`node:sqlite` / `node:http` / `node:crypto` / `node:test`）；
  确实绕不过去请在 PR 里说明理由和体积影响；
- 服务器与前端都跑在中文语境：用户可见文案用中文，标识符用英文；
- 错误走统一信封：`sendError(res, status, CODE, message)`，`CODE` 用 `SCREAMING_SNAKE`；
- 时间一律 ISO 字符串（`new Date().toISOString()`），数据库里存 TEXT；
- 提交前 `git diff` 自查：不要带 `var/`、`.env`、`*.db`、截图临时文件。

## 5. 提交信息

采用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(review): 支持并签审核策略
fix(engine): reconcile 返回数组而非对象
docs(readme): 补充 Node 版本要求
test(smoke): 增加质量配置 Σ≠100 用例
```

一次提交只做一件事。格式化/重命名请单独一次提交，避免淹没语义 diff。

## 6. PR 检查清单

- [ ] `node server/smoke.mjs` 全绿（42/0/1 或更好），并在 PR 描述里贴结果尾行
- [ ] 没有新增 npm 依赖；没有提交 `.env` / `var/` / `*.db`
- [ ] 改了接口 → 同步更新 `README.md` §7「API 一览」
- [ ] 改了行为 → 在 `CHANGELOG.md` 的 `Unreleased` 下加一行
- [ ] 涉及模型调用 → 确认无 key 落库、无 key 下发到前端（`GET /api/llm/status` 只回 `ready`）

## 7. 安全问题

不要开公开 issue，见 [SECURITY.md](SECURITY.md)。
