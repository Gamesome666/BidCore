// 平台说明：能力地图（三块）+ 5 分钟演示路径 + 接口/错误码速查 + 技术栈。
import { escapeHtml, pill } from '../lib/ui.js';

const esc = escapeHtml;

const CAPABILITIES = [
  {
    icon: '⋈',
    title: 'Supervisor 动态调度',
    desc: '模型只产出计划，调度/并行/重试/失效全部由确定性代码执行。',
    points: [
      '计划 JSON 经 7 条校验（节点数/唯一 key/依赖无环/导出终结点…），非法立即兜底',
      '按依赖深度分层，同层并行派发，并发槽位受 parallelism 与预算约束',
      '质量未达标 → 按规则码映射返工目标 → replan（plan_version+1），已成功节点不重跑',
      '中断/崩溃后按租约对账回收，节点 attempt+1 重新入队',
    ],
    links: [['#/runs', '运行看板'], ['#/workflow', '编排模板'], ['#/agents', 'Agent 团队']],
  },
  {
    icon: '✓',
    title: 'HITL 四动作 + 多级 SLA',
    desc: '人工门禁把工作流挂起，人做裁决，系统按裁决定向回退或继续。',
    points: [
      '四动作：通过 / 驳回 / 修改 / 要求重新分析（后三者必须选上游目标 + ≥10 字意见）',
      '多级流转：项目负责人 → 商务负责人 → 管理员，逐级 approve 才放行',
      'SLA：按比例提醒 + 超时升级或催办（remind-only / escalate 两种策略）',
      '修改支持结构化 edits（段落锚点=替换文本），提交带 commandId 幂等 + 乐观锁防并发',
    ],
    links: [['#/reviews', '审核中心'], ['#/settings', '审核 SLA']],
  },
  {
    icon: '◔',
    title: 'Self-Loop 双轨评分',
    desc: '确定性规则引擎 + 受限评委 rubric（不自我打分），两轨证据合并成可信分数，低于阈值自动返工。',
    points: [
      '14 条规则覆盖完整性/准确性/技术性/匹配度/规范性，每条可定位到正文证据',
      '五维加权求和（Σ=100），达标 80 / 返工 60 可配置',
      '预算使用 >85% 自动跳过第二遍评委，先保结果',
      '迭代趋势可视化，人工可"接受现状"留痕（override）',
    ],
    links: [['#/quality', '质量报告'], ['#/settings', '质量权重']],
  },
];

const DEMO_STEPS = [
  { t: '0:00', stage: '总览', action: '登录 admin/admin123，看工作台总览与侧边角标', point: '一眼看到运行数、待审待办、超时数' },
  { t: '0:40', stage: '启动', action: '点顶栏「▶ 启动工作流」→ 选择项目 → 启动', point: 'Supervisor 先出计划，再并行调度 8 个 Agent' },
  { t: '1:30', stage: '运行详情', action: '进入 #/runs/:id：看 DAG 节点颜色、事件流、右侧决策流水与预算', point: '并发批次、重规划、失效传播都是可见事件' },
  { t: '2:40', stage: '人工门禁', action: '运行停在 waiting_human → 审核中心可见待办 → 打开审核详情', point: '左侧产物正文、右侧质量证据与上游意见同屏' },
  { t: '3:40', stage: '四动作', action: '选「修改」：勾选上游 Agent + 写 ≥10 字意见 + 一行「锚点=替换文本」提交', point: '节点 iteration+1 回到 ready，下游自动失效重跑' },
  { t: '4:30', stage: '质量闭环', action: '打开质量报告：雷达图对比上一版、规则证据按码分组、迭代趋势', point: '低分自动返工；人工可接受现状留痕' },
  { t: '5:00', stage: '收尾', action: '平台设置里切 mock/openai 模型、看权重 Σ=100 校验', point: '模型、质量口径、SLA 都可运营化配置' },
];

const API_ROWS = [
  ['POST', '/api/auth/login', '登录，返回 token + user'],
  ['GET', '/api/me', '当前用户'],
  ['GET/POST', '/api/projects', '项目列表 / 新建'],
  ['POST', '/api/runs', '启动工作流（projectId/objective/dryRun）'],
  ['GET', '/api/runs', '运行列表（含 project_name/node_count/waiting）'],
  ['GET', '/api/runs/:id', '运行快照：run/plan/nodes/artifacts/reviews/quality/stats'],
  ['POST', '/api/runs/:id/commands', 'pause / resume / cancel / reconcile / retry-node（幂等 commandId）'],
  ['GET', '/api/runs/:id/events?afterSeq=', '事件增量（seq 递增）'],
  ['GET', '/api/runs/:id/artifacts', '产物版本列表（kind/version/sha256/summary）'],
  ['GET', '/api/runs/:id/artifacts/:kind', '某类产物全部版本 + payload'],
  ['GET', '/api/runs/:id/diff?kind&from&to', '版本差异（ops）'],
  ['GET', '/api/runs/:id/quality', '质量报告（维度/证据/评委）'],
  ['GET', '/api/reviews?status&assignee&overdue&projectId', '审核任务列表'],
  ['GET', '/api/reviews/summary', '待我 / 全部 / 超时 计数'],
  ['GET', '/api/reviews/:id', 'ReviewPacket（产物/质量/diff/历史/目标/SLA）'],
  ['POST', '/api/reviews/:id/decisions', '四动作裁决（action/comment/targets/edits/commandId）'],
  ['POST', '/api/reviews/:id/remind', '催办'],
  ['GET', '/api/reviews/:id/history', '决策历史'],
  ['GET', '/api/knowledge', '四库素材（library=doc/tool/company/personnel）'],
  ['GET', '/api/agents · PUT /api/agents/:id', '9 角色配置与启停'],
  ['GET / POST', '/api/workflow-defs', '编排模板读取 / 保存新版本'],
  ['GET / PUT', '/api/settings', '平台设置（llm/quality/review/workflow）'],
  ['GET', '/api/llm/status', '模型探活状态（mode/provider/ready）'],
  ['GET', '/api/events?projectId=&token=', 'SSE：workflow / review / quality / tasks'],
];

const ERROR_ROWS = [
  ['REVIEW_ALREADY_DECIDED', '同一任务被并发处理或已关闭', '提示"已被他人处理"并刷新页面'],
  ['REVIEW_COMMENT_TOO_SHORT', '非通过动作意见 <10 字', '弹窗内提示补足意见'],
  ['REVIEW_TARGET_REQUIRED', '驳回/修改未选目标', '提示勾选上游 Agent'],
  ['REVIEW_TARGET_NOT_ANCESTOR', '目标不是祖先节点', '提示只能选上游；目标清单由 ancestors 生成'],
  ['REVIEW_COMMAND_ID_REQUIRED', '缺少 commandId（幂等键）', '前端统一用 crypto.randomUUID()'],
  ['QUALITY_CONFIG_INVALID', '权重之和≠100 或阈值倒挂', '保存前客户端预校验，服务端兜底'],
  ['WF_PLAN_INVALID', '计划 JSON 非法（节点/依赖/环/无导出）', '编排模板页展示 7 条校验明细'],
  ['COMMAND_FAILED', '运行状态不允许该命令', 'toast 展示错误信息'],
  ['EXPORT_BLOCKED', '导出前校验未通过', '导出页列出阻断项'],
];

const STACK = [
  ['运行时', 'Node.js 24（零 npm 依赖）', '无构建、无打包器，node server/index.mjs 即启动'],
  ['数据层', 'node:sqlite 单文件 var/bidcore.db', 'WAL 模式；表结构与设计文档的 PostgreSQL 版一一对应'],
  ['前端', '零构建 ESM SPA + hash 路由', 'web/lib/ui.js 组件库：DAG / 雷达 / 时间线 / 抽屉 / 弹窗'],
  ['实时', 'SSE（/api/events）', 'workflow / review / quality / tasks 四频道，前端按事件刷新'],
  ['模型', 'OpenAI 兼容网关 · deepseek-v4.1-flash', 'opencode 网关需 x-opencode-session；mock 模式可离线完整演示'],
  ['调度', '确定性引擎 + 租约', '节点 lease/attempt/iteration，崩溃后对账回收'],
];

export default {
  title: '平台说明',

  async render(root, ctx) {
    root.innerHTML = `
      <div class="page-head">
        <div>
          <div class="page-title">BidCore · 标序</div>
          <div class="page-desc">可人工干预的 Multi-Agent 投标标书平台 —— Supervisor 动态调度 · Human-in-the-Loop 审核 · Self-Loop 质量闭环。
            对标 yibiao 的信息架构，但把"人"放回关键节点上。</div>
        </div>
        <div class="page-actions">
          <a class="btn" href="#/dashboard">回到总览</a>
          <a class="btn primary" href="#/runs">去运行看板</a>
        </div>
      </div>

      <div class="grid c3 mb16">
        ${CAPABILITIES.map((cap) => `
          <div class="card">
            <div class="row" style="gap:10px;align-items:flex-start">
              <div class="brand-mark" style="width:34px;height:34px;font-size:17px;background:var(--paper-2);color:var(--accent);box-shadow:none">${cap.icon}</div>
              <div>
                <div class="card-title">${esc(cap.title)}</div>
                <div class="card-sub">${esc(cap.desc)}</div>
              </div>
            </div>
            <ul class="mt12" style="padding-left:16px">
              ${cap.points.map((p) => `<li class="fs12" style="margin:6px 0;color:var(--ink-3)">${esc(p)}</li>`).join('')}
            </ul>
            <div class="row wrap mt12" style="gap:6px">
              ${cap.links.map(([href, label]) => `<a class="btn xs" href="${href}">${esc(label)} →</a>`).join('')}
            </div>
          </div>`).join('')}
      </div>

      <div class="card mb16">
        <div class="card-head" style="padding:0 0 12px;border:0">
          <div class="card-title">5 分钟演示路径 <span class="hint" style="font-weight:400">评委视角：一条主线走完三个卖点</span></div>
          <div class="right">${pill('约 5 分钟', 'accent')}</div>
        </div>
        <div class="steps">
          ${DEMO_STEPS.slice(0, 5).map((step, i) => `<div class="step ${i === 0 ? 'active' : ''}">
            <span class="s-idx">${i + 1}</span><span class="s-label">${esc(step.stage)} · ${esc(step.t)}</span></div>`).join('')}
        </div>
        <div class="table-wrap mt12">
          <table class="table compact">
            <thead><tr><th class="col-tight">#</th><th class="col-tight">时间</th><th>页面</th><th>操作</th><th>看点</th></tr></thead>
            <tbody>
              ${DEMO_STEPS.map((step, i) => `<tr>
                <td class="mono">${i + 1}</td>
                <td class="mono nowrap">${esc(step.t)}</td>
                <td>${esc(step.stage)}</td>
                <td>${esc(step.action)}</td>
                <td class="hint">${esc(step.point)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <div class="grid c2 mb16" style="align-items:start">
        <div class="card">
          <div class="card-head" style="padding:0 0 12px;border:0">
            <div class="card-title">接口速查</div>
            <div class="right hint">${API_ROWS.length} 条主链路</div>
          </div>
          <div class="table-wrap scroll-y" style="max-height:460px">
            <table class="table compact">
              <thead><tr><th class="col-tight">方法</th><th>路径</th><th>说明</th></tr></thead>
              <tbody>
                ${API_ROWS.map(([method, path, desc]) => `<tr>
                  <td class="col-tight"><span class="pill ${method.includes('POST') ? 'accent' : method.includes('PUT') ? 'violet' : 'plain'} mono" style="height:18px">${esc(method)}</span></td>
                  <td class="mono fs11">${esc(path)}</td>
                  <td class="hint fs11">${esc(desc)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
        <div class="stack-gap">
          <div class="card">
            <div class="card-title">错误码速查</div>
            <div class="table-wrap mt12">
              <table class="table compact">
                <thead><tr><th>错误码</th><th>触发</th><th>前端表现</th></tr></thead>
                <tbody>
                  ${ERROR_ROWS.map(([code, when, ui]) => `<tr>
                    <td class="mono fs11 accent">${esc(code)}</td>
                    <td class="hint fs11">${esc(when)}</td>
                    <td class="hint fs11">${esc(ui)}</td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>
          </div>
          <div class="card">
            <div class="card-title">演示账号</div>
            <div class="grid c2 mt12" style="gap:8px">
              ${[
                ['admin', 'admin123', '管理员：全部权限'],
                ['owner', 'owner123', '项目负责人：一级审核'],
                ['tech', 'tech123', '技术负责人：并签审核'],
                ['biz', 'biz123', '商务负责人：二级审核'],
                ['reviewer', 'reviewer123', '质量审核员'],
              ].map(([u, p, note]) => `<div class="bg-soft" style="border-radius:8px;padding:8px 10px">
                <div class="mono fs12 ink">${esc(u)} / ${esc(p)}</div>
                <div class="hint fs11">${esc(note)}</div>
              </div>`).join('')}
            </div>
            <div class="hint fs11 mt8">当前登录：${esc(ctx.user?.display_name || ctx.user?.username || '-')} · ${esc(ctx.user?.role || '')}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head" style="padding:0 0 12px;border:0">
          <div class="card-title">技术栈与取舍</div>
          <div class="right hint">单机可跑 · 零依赖 · 可迁移</div>
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>层次</th><th>选型</th><th>为什么</th></tr></thead>
            <tbody>
              ${STACK.map(([layer, choice, why]) => `<tr>
                <td class="nowrap fw6 ink">${esc(layer)}</td>
                <td>${esc(choice)}</td>
                <td class="hint">${esc(why)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="divider"></div>
        <div class="grid c3">
          <div><div class="hint fs11">运行</div><div class="mono fs12">cd bidcore &amp;&amp; node server/index.mjs</div></div>
          <div><div class="hint fs11">默认地址</div><div class="mono fs12">http://127.0.0.1:5192</div></div>
          <div><div class="hint fs11">数据文件</div><div class="mono fs12">var/bidcore.db（SQLite WAL）</div></div>
        </div>
      </div>`;

    return { refresh: () => {}, destroy: () => {} };
  },
};
