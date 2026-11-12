// 质量报告：运行选择 + 报告列表 + 雷达/维度/规则证据 + 评委 JSON + 迭代趋势 + 人工接受现状。
// 优先 /api/quality/reports，其次 /api/runs/:id/quality；两者都不可用时给出空态说明。
import { api } from '../lib/api.js';
import {
  $, $$, escapeHtml, pill, statusPill, verdictPill, emptyState, loading, toast, modal,
  scoreRing, radar, sparkline, barRow, copyText, dimLabel, fmtTime, fmtDateTime, fmtRelative, scoreClass,
} from '../lib/ui.js';

const esc = escapeHtml;
const VERDICT_HINT = {
  pass: '≥ 达标线：产物可直接进入人工审核',
  revise: '介于返工线与达标线之间：定向返工后重评',
  regenerate: '低于返工线：重新生成',
  veto: '命中废标条款：必须修正后重跑合规检查',
  pending: '尚未评估',
};

function normalizeReports(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.reports)) return data.reports;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

/** evidence 可能是字符串或数组（规则轨命中证据列表，元素是 {type,ref,excerpt}） */
const pickEvidence = (item) => {
  if (typeof item === 'string') return item;
  if (!item || typeof item !== 'object') return String(item ?? '');
  const ref = item.ref || item.rule || '';
  const text = item.excerpt || item.text || item.label || item.message || item.value || '';
  if (ref && text) return `${ref}：${text}`;
  return text || ref || JSON.stringify(item);
};
const evidenceText = (finding) => {
  const ev = finding?.evidence;
  if (Array.isArray(ev)) return ev.map(pickEvidence).filter(Boolean).join('\n');
  if (ev === null || ev === undefined) return '';
  return pickEvidence(ev);
};

export default {
  title: '质量报告',

  async render(root, ctx) {
    const state = {
      runs: [],
      runId: ctx.query?.runId || '',
      reports: [],
      selectedId: '',
      source: '',
      loading: true,
      error: '',
      destroyed: false,
    };

    const runOf = (id) => state.runs.find((r) => String(r.id) === String(id));
    const selected = () => state.reports.find((r) => String(r.id) === String(state.selectedId)) || state.reports.at(-1) || null;

    function prevOf(report) {
      if (!report) return null;
      const same = state.reports.filter((r) => r.node_key === report.node_key);
      const idx = same.findIndex((r) => String(r.id) === String(report.id));
      return idx > 0 ? same[idx - 1] : null;
    }

    function trendOf(report) {
      if (!report) return [];
      return state.reports.filter((r) => r.node_key === report.node_key)
        .sort((a, b) => Number(a.iteration) - Number(b.iteration))
        .map((r) => Number(r.total_score));
    }

    async function loadRuns() {
      state.runs = await api.runs().catch(() => []);
      if (!state.runId || !state.runs.some((r) => String(r.id) === String(state.runId))) {
        state.runId = state.runs[0]?.id || '';
      }
    }

    async function loadReports() {
      state.reports = [];
      state.source = '';
      if (!state.runId) { state.loading = false; return; }
      try {
        const data = await api.qualityReports(state.runId);
        const rows = normalizeReports(data);
        if (rows.length) { state.reports = rows; state.source = 'quality/reports'; }
      } catch { /* 接口未就绪 */ }
      if (!state.reports.length) {
        try {
          const rows = await api.quality(state.runId);
          state.reports = normalizeReports(rows).map((r) => ({
            ...r,
            total_score: r.total_score ?? r.total,
            dimension_json: r.dimension_json || r.dimensions || {},
            findings_json: r.findings_json || r.findings || [],
            judge_json: r.judge_json || r.judge || {},
          }));
          state.source = 'runs/:id/quality';
        } catch (error) {
          state.error = error.message || String(error);
        }
      }
      state.reports.sort((a, b) => Number(a.iteration || 0) - Number(b.iteration || 0));
      state.selectedId = state.reports.at(-1)?.id || '';
      state.loading = false;
    }

    /* ------------------------------------------------ 片段 */
    function head() {
      const run = runOf(state.runId);
      return `<div class="page-head">
        <div>
          <div class="page-title">质量报告</div>
          <div class="page-desc">Self-Loop 双轨评分：确定性规则（14 条）+ 受限评委 rubric。低于阈值会触发定向返工，返工目标来自规则码映射。</div>
        </div>
        <div class="page-actions">
          <select class="select" id="q-run" style="min-width:280px">
            ${state.runs.length
              ? state.runs.map((r) => `<option value="${esc(r.id)}" ${String(r.id) === String(state.runId) ? 'selected' : ''}>
                  ${esc(String(r.id).slice(0, 12))} · ${esc(r.project_name || `项目 #${r.project_id}`)} · ${esc(r.started_at ? fmtTime(r.started_at) : '')}
                </option>`).join('')
              : '<option value="">暂无运行</option>'}
          </select>
          ${run ? `<a class="btn" href="#/runs/${esc(run.id)}">打开运行</a>` : ''}
          <button class="btn ghost" id="q-reload">刷新</button>
        </div>
      </div>`;
    }

    function reportList() {
      if (!state.reports.length) {
        return emptyState('该运行还没有质量报告', '质量节点执行或人工触发评估后，这里会出现迭代记录', '◔');
      }
      return `<div class="table-wrap">
        <table class="table compact">
          <thead><tr><th>迭代</th><th>节点</th><th class="num">总分</th><th>结论</th><th>时间</th></tr></thead>
          <tbody>
            ${state.reports.map((r) => `
              <tr class="clickable ${String(r.id) === String(state.selectedId) ? 'selected' : ''}" data-report="${esc(r.id)}">
                <td class="mono">#${esc(String(r.iteration ?? 1))}</td>
                <td class="mono fs11 nowrap">${esc(r.node_key || '-')}</td>
                <td class="num"><span class="${scoreClass(r.total_score)} fw6">${esc(String(r.total_score ?? '-'))}</span></td>
                <td class="nowrap">${verdictPill(r.verdict)}</td>
                <td class="hint nowrap fs11">${fmtTime(r.created_at, false)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
    }

    function findingsCard(report) {
      const findings = report.findings_json || report.findings || [];
      if (!findings.length) return `<div class="card"><div class="card-title">规则证据</div><div class="hint mt8">无规则命中</div></div>`;
      const scored = findings.filter((f) => !f.skipped && f.score !== null && f.score !== undefined);
      const skipped = findings.filter((f) => f.skipped || f.score === null || f.score === undefined);
      const groups = new Map();
      for (const f of scored) {
        const code = f.rule || f.code || 'RULE';
        if (!groups.has(code)) groups.set(code, []);
        groups.get(code).push(f);
      }
      const warnCount = scored.filter((f) => (f.score ?? 100) < 80 || f.severity === 'blocking' || f.severity === 'veto').length;
      const perfect = scored.filter((f) => (f.score ?? 0) >= 100).length;
      const tone = (f) => (f.severity === 'veto' || f.severity === 'blocking' ? 'bad' : (f.score ?? 100) < 80 ? 'warn' : (f.score ?? 100) >= 100 ? 'ok' : 'plain');
      const rowOf = (f, first) => `<tr class="${first ? 'fw6' : ''}">
        ${first ? `<td class="nowrap" style="width:104px"><code>${esc(f.rule || '')}</code><div class="hint fs11">${esc(f.label || '')}</div></td>` : '<td></td>'}
        <td class="nowrap">${f.dimension ? `<span class="tag soft">${esc(dimLabel(f.dimension))}</span>` : '—'}</td>
        <td class="num"><span class="pill ${tone(f)}">${esc(String(f.score ?? '—'))}</span></td>
        <td class="nowrap">${esc(f.severity || '')}</td>
        <td>${esc(f.message || f.title || '')}
          ${evidenceText(f) ? `<div class="f-evidence" style="white-space:pre-wrap;margin-top:3px">${esc(evidenceText(f).slice(0, 300))}</div>` : ''}</td>
        <td class="col-tight">${evidenceText(f) ? `<button class="btn xs" data-copy="${esc(evidenceText(f).slice(0, 300))}">复制</button>` : ''}</td>
      </tr>`;
      return `<div class="card">
        <div class="card-head" style="padding:0 0 10px;border:0">
          <div class="card-title">规则证据 <span class="hint" style="font-weight:400">14 条确定性规则 · 按规则码分组</span></div>
          <div class="right row" style="gap:6px">
            <span class="pill ok">${perfect} 条满分</span>
            <span class="pill ${warnCount ? 'warn' : 'plain'}">${warnCount} 条需关注</span>
            <span class="pill plain">${skipped.length} 条已跳过</span>
          </div>
        </div>
        <div class="table-wrap">
          <table class="table compact">
            <thead><tr><th style="width:104px">规则</th><th>维度</th><th class="num" style="width:64px">得分</th><th style="width:74px">级别</th><th>说明与证据</th><th class="col-tight"></th></tr></thead>
            <tbody>
              ${[...groups.entries()].map(([, list]) => list.map((f, i) => rowOf(f, i === 0)).join('')).join('')
                || '<tr><td colspan="6" class="hint">所有规则均未产出可评分结果</td></tr>'}
            </tbody>
          </table>
        </div>
        ${skipped.length ? `<details class="mt12">
          <summary class="hint pointer">已跳过 / 未执行的规则（${skipped.length} 条）：缺前置产物或该检查尚未运行</summary>
          <div class="table-wrap mt8">
            <table class="table compact">
              <thead><tr><th style="width:104px">规则</th><th>维度</th><th>原因</th><th class="num" style="width:64px">得分</th></tr></thead>
              <tbody>${skipped.map((f) => `<tr>
                <td class="nowrap"><code>${esc(f.rule || '')}</code><div class="hint fs11">${esc(f.label || '')}</div></td>
                <td class="nowrap">${f.dimension ? `<span class="tag soft">${esc(dimLabel(f.dimension))}</span>` : '—'}</td>
                <td class="hint">${esc(f.message || '')}</td>
                <td class="num hint">—</td>
              </tr>`).join('')}</tbody>
            </table>
          </div>
        </details>` : ''}
      </div>`;
    }

    function detailCard(report) {
      if (!report) return `<div class="card">${emptyState('选择一份报告', '左侧列表点选迭代记录查看维度与证据')}</div>`;
      const dims = report.dimension_json || report.dimensions || {};
      const prev = prevOf(report);
      const prevDims = prev?.dimension_json || prev?.dimensions || null;
      const judge = report.judge_json || report.judge || {};
      const trend = trendOf(report);
      return `<div class="stack-gap">
        <div class="card">
          <div class="flex-between" style="align-items:flex-start">
            <div>
              <div class="card-title">第 ${esc(String(report.iteration ?? 1))} 次评估 · ${esc(report.node_key || '-')}</div>
              <div class="card-sub">${fmtDateTime(report.created_at)} · 数据源 ${esc(state.source || '-')}</div>
            </div>
            <div class="row" style="gap:6px">${verdictPill(report.verdict)}${prev ? `<span class="pill plain">上一版 ${esc(String(prev.total_score))} 分</span>` : ''}</div>
          </div>
          <div class="row" style="gap:22px;align-items:center;margin-top:14px;flex-wrap:wrap">
            ${scoreRing(report.total_score ?? 0, 116)}
            <div style="flex:1;min-width:240px">
              <div class="hint fs11">${esc(VERDICT_HINT[report.verdict] || '')}</div>
              <div class="stack mt12" style="gap:7px">
                ${Object.entries(dims).map(([key, dim]) => barRow(
                  dimLabel(key),
                  dim.score ?? dim ?? 0,
                  100,
                  (dim.score ?? dim ?? 0) >= 80 ? 'jade' : (dim.score ?? dim ?? 0) >= 60 ? 'warn' : 'bad',
                )).join('') || '<div class="hint">无维度数据</div>'}
              </div>
            </div>
            <div style="text-align:center;min-width:190px">
              <div class="hint fs11 mb4">同节点迭代趋势</div>
              ${sparkline(trend, { width: 190, height: 46 })}
              <div class="hint fs11 mt4">${trend.map((v) => v).join(' → ') || '—'}</div>
            </div>
          </div>
        </div>

        <div class="grid c2" style="align-items:start">
          <div class="card">
            <div class="card-title">维度雷达</div>
            <div class="mt12" style="display:flex;justify-content:center">
              ${radar(dims, prevDims || undefined)}
            </div>
            ${prevDims ? '<div class="hint fs11" style="text-align:center">虚线为上一版</div>' : ''}
          </div>
          <div class="card">
            <div class="card-title">评委（受限 rubric）</div>
            <div class="mt8">
              <details ${Object.keys(judge).length ? '' : 'open'}>
                <summary class="hint pointer">评委原始 JSON（${Object.keys(judge).length} 个字段）</summary>
                <pre class="mono mt8" style="white-space:pre-wrap;font-size:11.5px;line-height:1.6;background:var(--card-2);border:1px solid var(--line);border-radius:8px;padding:10px;max-height:300px;overflow:auto">${esc(JSON.stringify(judge, null, 2) || '{}')}</pre>
              </details>
            </div>
            <div class="divider"></div>
            <div class="row wrap" style="gap:6px">
              <span class="hint fs11">评审轨：</span>
              <span class="pill ${judge.two_pass ? 'ok' : 'plain'}">${judge.two_pass ? '两遍评委' : '单遍评委'}</span>
              ${judge.model ? `<span class="tag soft">${esc(judge.model)}</span>` : ''}
              ${judge.skip_reason ? `<span class="pill warn">${esc(judge.skip_reason)}</span>` : ''}
            </div>
          </div>
        </div>

        ${findingsCard(report)}
      </div>`;
    }

    function paint() {
      if (state.destroyed) return;
      const report = selected();
      const run = runOf(state.runId);
      root.innerHTML = `${head()}
        ${state.loading
          ? `<div class="card">${loading('加载质量报告…')}</div>`
          : `<div class="grid side">
              <div>${state.reports.length ? detailCard(report) : `<div class="card">${reportList()}
                <div class="hint mt8">接口检查：<span class="mono">GET /api/quality/reports</span> 与 <span class="mono">GET /api/runs/:id/quality</span> ${state.error ? '均不可用' : '暂无数据'}${state.error ? `（${esc(state.error)}）` : ''}。</div>
              </div>`}</div>
              <div class="stack-gap">
                <div class="card">
                  <div class="card-head" style="padding:0 0 10px;border:0">
                    <div class="card-title">报告列表</div>
                    <span class="right hint">${state.reports.length} 份</span>
                  </div>
                  ${reportList()}
                </div>
                <div class="card">
                  <div class="card-title">运行</div>
                  <div class="fs12 mt8">${run ? `${esc(run.project_name || '')} ${statusPill(run.status)}` : '未选择运行'}</div>
                  ${run ? `<div class="hint fs11 mt4 mono">${esc(run.id)}</div>` : ''}
                  ${run ? `<div class="hint fs11 mt4">启动 ${fmtRelative(run.started_at)} · 计划 v${esc(String(run.plan_version || 0))}</div>` : ''}
                </div>
                <div class="card">
                  <div class="card-title">人工接受现状</div>
                  <p class="hint fs11 mt4">在业务上认可当前质量、不再返工时使用。会写入 judge_json.override 并留下操作人。</p>
                  <button class="btn sm w-full mt8" id="q-override" ${!report || report.verdict === 'pass' ? 'disabled' : ''}>接受当前质量</button>
                  <div class="hint fs11 mt8">接口：<span class="mono">POST /api/runs/:id/quality/:reportId/override</span>（未就绪时自动降级提示）</div>
                </div>
              </div>
            </div>`}`;
      bind(report);
    }

    function bind(report) {
      const select = $('#q-run', root);
      if (select) {
        select.onchange = async () => {
          state.runId = select.value;
          state.loading = true;
          paint();
          try {
            await loadReports();
          } catch (error) {
            state.error = error.message || String(error);
          }
          paint();
        };
      }
      const reload = $('#q-reload', root);
      if (reload) {
        reload.onclick = async () => {
          state.loading = true;
          paint();
          await loadRuns();
          await loadReports();
          paint();
        };
      }
      $$('[data-report]', root).forEach((row) => {
        row.onclick = () => { state.selectedId = row.dataset.report; paint(); };
      });
      $$('[data-copy]', root).forEach((button) => {
        button.onclick = (event) => { event.stopPropagation(); copyText(button.dataset.copy); };
      });
      const override = $('#q-override', root);
      if (override && report) {
        override.onclick = () => {
          const box = modal({
            title: '人工接受当前质量',
            body: `<p class="hint mb12">该动作会在报告上留痕（override），不改变评分，仅表示业务上接受当前产物。</p>
              <div class="field"><label>说明（可选）</label>
                <textarea class="textarea" id="ov-comment" placeholder="例：时间窗内优先交付，已知差距已由商务补充说明。"></textarea></div>`,
            footer: `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="ov-ok">确认接受</button>`,
          });
          $('#ov-ok', box.root).onclick = async (event) => {
            const button = event.currentTarget;
            button.disabled = true;
            try {
              await api.post(`/api/runs/${encodeURIComponent(state.runId)}/quality/${encodeURIComponent(report.id)}/override`, {
                comment: $('#ov-comment', box.root).value.trim(),
              });
              box.close();
              toast('已记录人工接受', '报告已标记 override', 'ok');
              await loadReports();
              paint();
            } catch (error) {
              button.disabled = false;
              box.close();
              toast('override 接口未就绪', `${error.code || error.status || ''} · 已保留本地判断，请在评审记录中说明`.trim(), 'warn');
            }
          };
        };
      }
    }

    /* ------------------------------------------------ 首屏 */
    root.innerHTML = loading('加载运行与质量报告…');
    await loadRuns();
    try {
      await loadReports();
    } catch (error) {
      state.error = error.message || String(error);
      state.loading = false;
    }
    if (!state.runs.length) {
      root.innerHTML = `<div class="page-head"><div><div class="page-title">质量报告</div></div></div>
        <div class="card">${emptyState('还没有可评估的运行', '先在运行看板启动一次工作流；质量节点执行后会生成报告', '◔')}</div>`;
      return { refresh: () => {}, destroy: () => { state.destroyed = true; } };
    }
    paint();

    return {
      refresh: async () => {
        if (state.destroyed) return;
        try { await loadReports(); paint(); } catch (error) { toast('刷新失败', error.message, 'bad'); }
      },
      destroy: () => { state.destroyed = true; },
    };
  },
};
