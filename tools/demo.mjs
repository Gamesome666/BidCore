#!/usr/bin/env node
// 演示数据编排（幂等）：把「技术方案全流程 + 一条停在审核中心 + 一条已完成运行」准备好，供截图/现场演示。
//
// 用法：
//   node tools/demo.mjs
//   BIDCORE_BASE=http://127.0.0.1:5197 node tools/demo.mjs
//
// 特性：
//   · 幂等：已存在的 waiting_human 运行 / completed 运行会复用，不会每次新增一堆运行；
//   · 真实模型慢时先切 llm.mode=mock，结束后恢复原值（finally 保证）；
//   · 失败打印可读原因（HTTP 状态 + 服务端 error），不吞异常。
const BASE = String(process.env.BIDCORE_BASE || 'http://127.0.0.1:5192').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(...args);

let token = '';
let originalSettings = null;

async function api(method, path, { body, auth, headers = {}, timeout = 180_000, allow = [] } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const useToken = auth === undefined ? token : auth;
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(useToken ? { Authorization: `Bearer ${useToken}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text.slice(0, 500); }
    if (!res.ok && !allow.includes(res.status)) {
      const reason = data?.error || data?.code || text.slice(0, 200);
      const error = new Error(`${method} ${path} → ${res.status} ${reason}`);
      error.status = res.status;
      error.data = data;
      throw error;
    }
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

const unwrap = (res) => res.data;
const listOf = (v) => (Array.isArray(v) ? v : []);

async function waitFor(label, fn, timeoutMs = 180_000, interval = 600) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`等待超时 ${Math.round(timeoutMs / 1000)}s：${label}`);
}

async function pendingOf(runId) {
  const { data } = await api('GET', '/api/reviews?status=pending');
  return listOf(data).filter((r) => r.run_id === runId);
}

async function decide(taskId, action, comment, extra = {}) {
  return api('POST', `/api/reviews/${taskId}/decisions`, {
    body: { action, comment, commandId: crypto.randomUUID(), ...extra },
  });
}

/** 技术方案单步（接口未就绪时给出可读原因并返回 null，不中断整个 demo） */
async function step(projectId, name, options = {}) {
  try {
    const { data } = await api('POST', `/api/projects/${projectId}/technical-plan/steps`, { body: { step: name, options } });
    const status = data?.task?.status;
    log(`  · ${name.padEnd(9)} ${status === 'success' ? '✔' : `✘ ${status}`} ${data?.task?.logs?.at(-1) || ''}`);
    return data;
  } catch (error) {
    if (error.status === 404) {
      log(`  · ${name.padEnd(9)} ↷ 接口未实现（404），跳过`);
      return null;
    }
    log(`  · ${name.padEnd(9)} ✘ ${error.message}`);
    return null;
  }
}

let runWaiting = '';
let reviewWaiting = '';
let runDone = '';
let projectId = 0;

try {
  /* ---------- 0. 预检与登录 ---------- */
  try {
    await api('GET', '/api/health', { timeout: 4000, auth: '' });
  } catch (error) {
    console.error(`✘ 无法连接 ${BASE}：${error.message}`);
    console.error('  请先启动服务：cd bidcore && node server/index.mjs');
    process.exit(2);
  }
  const login = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' }, auth: '' });
  token = login.data.token;
  log(`\nBidCore 演示数据 — ${BASE}\n  登录：admin（${login.data.user.display_name}）`);

  /* ---------- 1. 选项目 ---------- */
  const projects = listOf(unwrap(await api('GET', '/api/projects')));
  if (!projects.length) {
    console.error('✘ 没有任何项目，无法生成演示数据（先 npm run reset 或手工建项目）');
    process.exit(1);
  }
  const chosen = projects.find((p) => String(p.name).includes('政务云')) || projects[0];
  projectId = chosen.id;
  log(`  项目：#${projectId}「${chosen.name}」/ ${chosen.code}`);

  /* ---------- 2. 切 mock（真实模型慢，构造完恢复） ---------- */
  originalSettings = unwrap(await api('GET', '/api/settings'));
  const prevMode = originalSettings.llm?.mode;
  await api('PUT', '/api/settings', { body: { llm: { ...originalSettings.llm, mode: 'mock' } } });
  log(`  模型：${prevMode} → mock（结束后恢复）`);

  /* ---------- 3. 技术方案全流程（工作台各 tab 有真实数据） ---------- */
  log('\n[1/3] 技术方案流水线（parse → outline → facts → content → checks → deviation → confirm → export）');
  const parse = await step(projectId, 'parse');
  if (!parse) throw new Error('parse 步骤不可用，无法继续技术方案链路');
  const outline = await step(projectId, 'outline');
  const facts = await step(projectId, 'facts');
  const content = await step(projectId, 'content');
  const checks = await step(projectId, 'checks');
  const deviation = await step(projectId, 'deviation');

  let confirmed = false;
  try {
    await api('POST', `/api/projects/${projectId}/deviation/confirm`, { body: {} });
    confirmed = true;
    log('  · confirm   ✔ 响应偏离表已人工确认');
  } catch (error) {
    log(`  · confirm   ↷ ${error.status === 404 ? '确认接口未实现（404）' : error.message}`);
  }

  let exportInfo = null;
  try {
    const { data } = await api('POST', `/api/projects/${projectId}/export`, { body: {} });
    exportInfo = data;
    log(`  · export    ✔ ${data.file}（${data.bytes} bytes，validation.ok=${data.validation?.ok}）`);
  } catch (error) {
    const blockers = error.data?.validation?.blockers?.map((b) => b.label || b.code) || [];
    log(`  · export    ${confirmed ? '✘' : '↷'} ${error.message}${blockers.length ? `（阻断：${blockers.join('、')}）` : ''}`);
    // 兜底：至少生成一个可下载的 Word，保证「导出」tab 有历史
    try {
      const { data } = await api('POST', '/api/export/docx', { body: { projectId } });
      exportInfo = { file: data.file, bytes: data.size, validation: { ok: false, note: '兼容层导出（未经前置校验）' } };
      log(`  · export    ↷ 已用兼容层导出 ${data.file}（${data.size} bytes，未过前置校验）`);
    } catch (fallbackError) {
      log(`  · export    ✘ 兼容层导出也失败：${fallbackError.message}`);
    }
  }

  const workspace = unwrap(await api('GET', `/api/projects/${projectId}/workspace`));
  log(`  工作台：step=${workspace.state?.step} / 章节 ${workspace.state?.content?.sections?.length ?? 0} / `
    + `废标 ${workspace.state?.checks?.rejection?.veto_count ?? 0} / 偏离 ${workspace.state?.deviation?.rows?.length ?? 0} 行`
    + `${confirmed ? '（已确认）' : ''} / 导出历史 ${workspace.exports?.length ?? 0}`);

  /* ---------- 4. 一条停在人工门禁的运行（审核中心演示） ---------- */
  log('\n[2/3] 等待人工门禁的运行（停住不动，供审核中心/四动作演示）');
  const runs = listOf(unwrap(await api('GET', `/api/runs?projectId=${projectId}`)));
  const reuse = [];
  for (const run of runs) {
    if (run.status !== 'waiting_human') continue;
    const pending = await pendingOf(run.id);
    if (pending.length) { reuse.push({ run, pending }); break; }
  }
  if (reuse.length) {
    runWaiting = reuse[0].run.id;
    reviewWaiting = reuse[0].pending[0].id;
    log(`  · 复用已有运行 ${runWaiting.slice(0, 14)}（${reuse[0].pending[0].gate_key} · ${reuse[0].pending.length} 个待审）`);
  } else {
    const { data } = await api('POST', '/api/runs', { body: { projectId, objective: '演示：人工门禁与四动作' } });
    runWaiting = data.run_id;
    const snap = await waitFor('运行到达人工门禁', async () => {
      const { data: s } = await api('GET', `/api/runs/${runWaiting}`);
      if (s?.run?.status === 'failed') throw new Error(`运行失败：${s.run.error_message || s.run.error_code}`);
      return s?.run?.status === 'waiting_human' ? s : null;
    });
    const pending = await waitFor('审核任务出现', async () => {
      const rows = await pendingOf(runWaiting);
      return rows.length ? rows : null;
    }, 60_000);
    reviewWaiting = pending[0].id;
    const gate = snap.nodes.find((n) => n.status === 'waiting_human');
    log(`  · 新建运行 ${runWaiting.slice(0, 14)} 停在 ${gate?.node_key}（待审 ${pending.length} 个）`);
  }

  /* ---------- 5. 一条已完成的运行（评分趋势 / DAG 完成态） ---------- */
  log('\n[3/3] 已完成的运行（评分趋势 / 导出产物）');
  const completed = runs.find((r) => r.status === 'completed');
  if (completed) {
    runDone = completed.id;
    log(`  · 复用已有已完成运行 ${runDone.slice(0, 14)}`);
  } else {
    const { data } = await api('POST', '/api/runs', { body: { projectId, objective: '演示：完整闭环并导出' } });
    runDone = data.run_id;
    const deadline = Date.now() + 240_000;
    let approvals = 0;
    while (Date.now() < deadline) {
      const { data: snap } = await api('GET', `/api/runs/${runDone}`);
      if (snap?.run?.status === 'completed') break;
      if (snap?.run?.status === 'failed') throw new Error(`运行失败：${snap.run.error_message || snap.run.error_code}`);
      const pending = await pendingOf(runDone);
      if (!pending.length) { await sleep(800); continue; }
      for (const task of pending) {
        const res = await decide(task.id, 'approve', '演示：审核通过，同意进入下一环节并导出正式投标文件。', {});
        if (res.status === 200) approvals += 1;
        log(`    ✔ approve ${task.gate_key} L${task.level}/${task.level_total}`);
      }
      await sleep(500);
    }
    const { data: final } = await api('GET', `/api/runs/${runDone}`);
    if (final?.run?.status !== 'completed') throw new Error(`运行未完成：${final?.run?.status} ${final?.run?.error_message || ''}`);
    log(`  · 新建运行 ${runDone.slice(0, 14)} 已完成（${approvals} 次人工决策）`);
  }

  const doneSnap = unwrap(await api('GET', `/api/runs/${runDone}`));
  const trend = listOf(doneSnap.quality).map((q) => `${q.node_key}#${q.iteration}:${q.total_score}/${q.verdict}`);
  log(`  · 质量趋势：${trend.join(' | ') || '（无质量报告）'}`);
  log(`  · 产物：${listOf(doneSnap.artifacts).filter((a) => a.status === 'active').map((a) => a.kind).join(', ')}`);

  /* ---------- 6. 汇总 ---------- */
  const summary = {
    base: BASE,
    projectId,
    projectName: chosen.name,
    technicalPlan: {
      step: workspace.state?.step,
      requirements: workspace.state?.bid_analysis?.requirements?.length ?? 0,
      outlineNodes: workspace.state?.outline?.nodes?.length ?? 0,
      chapters: workspace.state?.content?.sections?.length ?? 0,
      words: workspace.state?.content?.total_words ?? 0,
      deviationRows: workspace.state?.deviation?.rows?.length ?? 0,
      deviationConfirmed: Boolean(workspace.state?.deviation?.confirmed),
      exportFile: exportInfo?.file ?? null,
      exportBytes: exportInfo?.bytes ?? null,
      exportValid: exportInfo?.validation?.ok ?? false,
    },
    waitingRun: runWaiting,
    waitingGate: (await pendingOf(runWaiting))[0]?.gate_key ?? null,
    reviewTask: reviewWaiting,
    completedRun: runDone,
    completedQuality: trend,
  };
  log('\n演示数据就绪：');
  log(JSON.stringify(summary, null, 2));
  log('\n截图建议（token 见下）：');
  log(`  node tools/shot.mjs "${BASE}/#/dashboard" docs/shots/dashboard.png --token=<token> --project=${projectId}`);
  log(`  node tools/shot.mjs "${BASE}/#/reviews"   docs/shots/reviews.png   --token=<token> --project=${projectId}`);
  log(`  node tools/shot.mjs "${BASE}/#/run/${runDone}" docs/shots/run.png --token=<token> --project=${projectId}`);
  log(`\nADMIN_TOKEN=${token}`);
} catch (error) {
  console.error(`\n✘ 演示数据生成失败：${error.message}`);
  if (error.data) console.error(`  服务端返回：${JSON.stringify(error.data).slice(0, 500)}`);
  process.exitCode = 1;
} finally {
  try {
    if (originalSettings?.llm) {
      await api('PUT', '/api/settings', { body: { llm: originalSettings.llm } });
      const status = unwrap(await api('GET', '/api/llm/status'));
      log(`\n模型配置已恢复：mode=${status.mode}`);
    }
  } catch (error) {
    console.error(`\n! 恢复 llm 配置失败（请手工在设置页改回）：${error.message}`);
  }
}
