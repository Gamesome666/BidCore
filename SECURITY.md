# 安全策略

## 报告漏洞

请**不要**用公开 issue 报告安全问题。用下面任一私密渠道：

1. GitHub → 仓库 **Security** 标签页 → **Report a vulnerability**（Private vulnerability reporting）；
2. 或直接给维护者发私信（见仓库主页联系方式）。

请附：受影响版本/提交、复现步骤、影响面（越权？读文件？泄露 key？）、你的环境（Node 版本、OS）。
48 小时内会有人回应；确认后在修复版本发布时一并致谢（除非你要求匿名）。

## 支持范围

只维护 `main` 分支的最新提交。历史提交不单独回补。

## 本项目的安全边界（部署前请读）

BidCore 是**可离线运行的演示/内部工具**，默认配置面向单人本机使用：

| 项 | 现状 | 对外暴露前必须做 |
|---|---|---|
| `HOST` | 默认 `127.0.0.1`，只监听本机 | 换成 `0.0.0.0` 前先加 TLS 反向代理与访问控制 |
| 认证 | 用户名 + 口令，口令用 `scrypt` 加盐哈希存库，token 为 HMAC-SHA256 签名的 `base64url(body).sig`，默认 7 天有效 | 接入企业 SSO / 改造成短时效 + 刷新令牌 |
| 令牌密钥 | `BIDCORE_SECRET` 未设置时回落到内置演示值 `bidcore-demo-secret-change-me` | **对外开放前必须设 `BIDCORE_SECRET`**（32 字节随机串），否则任何人都能伪造 token |
| 演示账号 | `admin/admin123` 等 5 个固定账号由种子数据写入 | 部署即改口令，或直接删掉种子账号 |
| 模型密钥 | 只从 `.env` 或数据库 `settings` 读，`GET /api/llm/status` **永不下发** key，设置页回显 `******` | 用环境变量注入，不要写进库；`.env` 已在 `.gitignore` |
| 生成内容 | 模型输出会被写入 Markdown 与 docx | 前端渲染 Markdown 时保持现有转义策略，勿改成 `innerHTML` 直出 |
| 文件导出 | docx 落在 `var/files/`，按项目 id 命名 | 多租户场景需要额外的路径校验与配额 |
| 依赖供应链 | 零 npm 依赖，无 `node_modules` | 保持零依赖；引入依赖需评审 |

## 已知非漏洞

- `var/*.db` 里能看到明文业务数据与演示口令哈希——这是本地演示库，不应提交或对外提供；
- `docs/shots/*.png` 中的模型配置页只显示打码后的 `******`；
- `tools/shot.mjs` 启动 headless 浏览器截本机页面，仅本地使用。
