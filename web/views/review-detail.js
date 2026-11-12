// 审核详情：ReviewPacket（产物/质量/差异/历史）+ 四动作面板
import { api } from '../lib/api.js';
import {
  escapeHtml, fmtTime, statusPill, verdictPill, scoreClass, renderMarkdown,
  renderRadar, toast, STATUS_LABEL,
} from '../lib/ui.js';

const ACTIONS = [
  { id: 'approve', label: '通过', desc: '进入下一级 / 推进下游' },
  { id: 'reject', label: '驳回', desc: '退回指定 Agent 重跑' },
  { id: 'modify', label: '修改', desc: '带修改意见重写' },
  { id: 'reanalyze', label: '重新分析', desc: '丢弃当前产物重做' },
];

function renderSubject(payload) {
  if (!payload) return '<div class="hint">暂无产物</div>';
  if (typeof payload.markdown === 'string') return `<div class="md">${renderMarkdown(payload.markdown)}</div>`;
  if (Array.isArray(payload.sections)) {
    return `<div class="md">${payload.sections.map((s) => `<h2>${escapeHtml(s.no)} ${escapeHtml(s.title)}</h2>${renderMarkdown(s.content)}`).join('')}</div>`;
  }
  if (payload.total != null && payload.dimensions) {
    return `<div class="split" style="margin-bottom:10px"><span class="pill info">质量评估</span>
      <strong style="font-size:22px">${payload.total}</strong>${verdictPill(payload.verdict)}</div>
      ${Object.values(payload.dimensions).map((d) => `
        <div style="margin-bottom:10px"><div class="split"><span class="hint">${escapeHtml(d.label)}（权重 ${d.weight}%）</span><span class="spacer"></span><strong>${d.score}</strong></div>
        <div class="bar ${d.score >= 80 ? '' : d.score >= 60 ? 'warn' : 'bad'}" style="margin-top:4px"><i style="width:${d.score}%"></i></div></div>`).join('')}`;
  }
  return `<pre class="mono" style="font-size:11.5px;line-height:1.6;white-space:pre-wrap;max-height:520px;overflow:auto">${escapeHtml(JSON.stringify(payload, null, 2)).slice(0, 30000)}</pre>`;
}

function renderDiff(diff) {
  if (!diff || diff.mode === 'none') return '<div class="empty-state">这是首个版本，暂无可对比的历史版本</div>';
  return `<div class="diff">${diff.ops.map((op, i) => `
    <div class="line ${op.type}"><span class="n">${i + 1}</span><span>${escapeHtml(op.text ?? `${op.path}: ${JSON.stringify(op.before)} → ${JSON.stringify(op.after)}`)}</span></div>`).join('')}
  </div>`;
}

function renderHistory(history) {
  if (!history?.length) return '<div class="empty-state">暂无审核记录</div>';
  return `<div class="timeline">${history.map((h) => `
    <div class="tl-item">
      <span class="tl-dot ${h.action}"></span>
      <div class="tl-body">
        <div class="top"><strong>${STATUS_LABEL[h.action] || h.action}</strong>
          <span class="hint">第 ${h.level} 级 · ${escapeHtml(h.reviewer?.display_name || h.reviewer?.username || '')}</span>
          <span class="spacer"></span><span class="hint">${fmtTime(h.at)}</span></div>
        <div class="cmt">${escapeHtml(h.comment || '')}</div>
        ${h.targets?.length ? `<div class="split" style="margin-top:4px">${h.targets.map((t) => `<span class="chip on">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      </div>
    </div>`).join('')}</div>`;
}

export default {
  async render(root, ctx) {
    const id = ctx.params.id;
    let packet;
    try {
      packet = await api.review(id);
    } catch (error) {
      root.innerHTML = `<div class="card"><div class="card-title">无法打开审核任务</div><p class="hint">${escapeHtml(error.message)}</p></div>`;
      return {};
    }

    const decided = packet.status !== 'pending';
    const sla = packet.sla;
    const slaCls = sla.overdue ? 'bad' : sla.minutes_left < 60 ? 'warn' : 'info';

    root.innerHTML = `
      <div class="review-layout">
        <div class="grid" style="gap:16px">
          <div class="card">
            <div class="split">
              <div>
                <div class="split" style="gap:8px">
                  <span class="pill info">${escapeHtml(packet.gate_key)}</span>
                  ${statusPill(packet.status)}
                  <span class="pill">第 ${packet.level}/${packet.level_total} 级</span>
                  ${packet.priority ? '<span class="pill bad">高优先级</span>' : ''}
                </div>
                <h2 style="margin:10px 0 4px;font-size:17px">${escapeHtml(packet.project?.name || '')}</h2>
                <div class="hint">产物 ${escapeHtml(packet.subject.artifact_kind)} v${packet.subject.version} · run ${packet.run_id.slice(0, 14)}
                  · ${packet.run_brief?.status ? STATUS_LABEL[packet.run_brief.status] || packet.run_brief.status : ''}</div>
              </div>
              <div class="spacer"></div>
              <div style="text-align:right">
                <div class="hint">SLA</div>
                <div class="pill ${slaCls}">${sla.overdue ? '已超时' : `剩余 ${sla.minutes_left} 分钟`}</div>
                <div class="hint" style="margin-top:4px">截止 ${fmtTime(sla.due_at)}</div>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="tabs" id="tabs">
              <div class="tab active" data-tab="subject">产物内容</div>
              <div class="tab" data-tab="quality">质量评估 ${packet.quality ? `<span class="count">${packet.quality.total}</span>` : ''}</div>
              <div class="tab" data-tab="diff">版本对比</div>
              <div class="tab" data-tab="history">审核历史 <span class="count">${packet.history.length}</span></div>
            </div>
            <div id="tab-body">
              <div data-panel="subject">${renderSubject(packet.subject.payload)}
                <div class="hint" style="margin-top:12px">${escapeHtml(packet.subject.summary || '')}</div>
              </div>
              <div data-panel="quality" hidden>
                ${packet.quality ? `
                  <div class="split" style="margin-bottom:12px">
                    <div>${renderRadar(packet.quality.dimensions)}</div>
                    <div style="flex:1">
                      <div class="split"><strong style="font-size:30px">${packet.quality.total}</strong>${verdictPill(packet.quality.verdict)}</div>
                      <div class="hint" style="margin:6px 0 10px">第 ${packet.quality.iteration} 次评估 · ${escapeHtml(packet.quality.judge?.cap_note || '')}</div>
                      ${packet.quality.findings.filter((f) => f.score !== null && f.score < 100).slice(0, 6).map((f) => `
                        <div class="finding"><span class="sev ${f.severity}"></span>
                          <div class="body"><div class="rule">${f.rule} · ${escapeHtml(f.label)}</div>
                            <div class="msg">${escapeHtml(f.message)}</div></div></div>`).join('') || '<div class="hint">全部规则通过</div>'}
                    </div>
                  </div>` : '<div class="empty-state">本门禁未关联质量报告</div>'}
              </div>
              <div data-panel="diff" hidden>${renderDiff(packet.diff)}</div>
              <div data-panel="history" hidden>${renderHistory(packet.history)}</div>
            </div>
          </div>
        </div>

        <div class="action-panel">
          <div class="card">
            <div class="card-head"><div class="card-title">审核决策</div>
              ${decided ? `<span class="pill">${STATUS_LABEL[packet.status] || packet.status}</span>` : '<span class="pill warn">待处理</span>'}</div>
            ${decided ? `
              <div class="empty-state" style="padding:18px">该任务已处理，决策记录见「审核历史」。</div>
              <a class="btn wide" href="#/review">返回审核中心</a>` : `
              <div class="action-seg" id="actions">
                ${ACTIONS.map((a) => `<button class="action-btn ${a.id}" data-action="${a.id}">
                  <strong>${a.label}</strong><span>${a.desc}</span></button>`).join('')}
              </div>
              <div class="field" style="margin-top:14px" id="target-field" hidden>
                <label>退回目标（只能选上游 Agent）</label>
                <div class="chip-set" id="targets">
                  ${packet.targets.map((t) => `<span class="chip" data-target="${escapeHtml(t.agent_key)}">${escapeHtml(t.label)}</span>`).join('') || '<span class="hint">无可选目标</span>'}
                </div>
                <div class="hint">规则：目标必须是该门禁的祖先节点，指向下游会被服务端拒绝（409）。</div>
              </div>
              <div class="field" style="margin-top:14px">
                <label>审核意见 <span class="hint" id="comment-hint">（非「通过」必填，≥10 字）</span></label>
                <textarea class="textarea" id="comment" placeholder="例如：技术方案第 5 章缺少等保三级整改台账，请补充并提供测评配合计划。"></textarea>
              </div>
              <div class="field" style="margin-top:10px" id="edits-field" hidden>
                <label>结构化修改项（可选，提交给 Agent 执行）</label>
                <div id="edits"></div>
                <button class="btn sm ghost" id="add-edit" style="margin-top:6px">+ 添加修改项</button>
              </div>
              <button class="btn primary wide" id="submit" style="margin-top:14px">提交决策</button>
              <div class="hint" style="margin-top:8px">提交后系统保存意见并自动恢复工作流；决策带幂等键，重复点击不会重复执行。</div>`}
          </div>

          <div class="card tight">
            <div class="card-title" style="margin-bottom:8px">上下文</div>
            <dl class="kv">
              <dt>项目</dt><dd>${escapeHtml(packet.project?.name || '')}</dd>
              <dt>投标人</dt><dd>${escapeHtml(packet.project?.bidder_name || '')}</dd>
              <dt>计划版本</dt><dd>v${packet.run_brief?.plan_version ?? 1}</dd>
              <dt>运行状态</dt><dd>${statusPill(packet.run_brief?.status || '')}</dd>
            </dl>
            <a class="btn sm ghost wide" style="margin-top:10px" href="#/run/${packet.run_id}">打开工作流运行</a>
          </div>
        </div>
      </div>`;

    root.querySelectorAll('[data-tab]').forEach((tab) => {
      tab.onclick = () => {
        root.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t === tab));
        root.querySelectorAll('[data-panel]').forEach((panel) => { panel.hidden = panel.dataset.panel !== tab.dataset.tab; });
      };
    });

    if (decided) return {};

    let action = null;
    const selectedTargets = new Set();
    const targetField = root.querySelector('#target-field');
    const editsField = root.querySelector('#edits-field');

    root.querySelectorAll('[data-action]').forEach((button) => {
      button.onclick = () => {
        action = button.dataset.action;
        root.querySelectorAll('[data-action]').forEach((b) => b.classList.toggle('sel', b === button));
        targetField.hidden = action === 'approve';
        editsField.hidden = action !== 'modify';
      };
    });

    root.querySelectorAll('[data-target]').forEach((chip) => {
      chip.onclick = () => {
        const key = chip.dataset.target;
        if (selectedTargets.has(key)) { selectedTargets.delete(key); chip.classList.remove('on'); }
        else { selectedTargets.add(key); chip.classList.add('on'); }
      };
    });

    const addEditRow = (path = '', value = '') => {
      const row = document.createElement('div');
      row.className = 'split';
      row.style.marginBottom = '6px';
      row.innerHTML = `<input class="input" placeholder="path，如 outline.add_section" value="${escapeHtml(path)}" style="flex:1" />
        <input class="input" placeholder="值/意见" value="${escapeHtml(value)}" style="flex:1.2" />`;
      root.querySelector('#edits').appendChild(row);
    };
    root.querySelector('#add-edit').onclick = () => addEditRow();

    root.querySelector('#submit').onclick = async () => {
      if (!action) return toast('请选择动作', '通过 / 驳回 / 修改 / 重新分析', 'bad');
      const comment = root.querySelector('#comment').value.trim();
      if (action !== 'approve' && comment.length < 10) return toast('审核意见太短', '非「通过」动作至少 10 个字', 'bad');
      if (action !== 'approve' && selectedTargets.size === 0) return toast('请选择退回目标', '只能选择上游 Agent', 'bad');
      const edits = action === 'modify'
        ? [...root.querySelectorAll('#edits .split')].map((row) => {
          const [p, v] = row.querySelectorAll('input');
          return p.value.trim() ? { op: 'append', path: p.value.trim(), value: v.value.trim() } : null;
        }).filter(Boolean)
        : [];
      const button = root.querySelector('#submit');
      button.disabled = true;
      button.textContent = '提交中…';
      try {
        const res = await api.decide(id, {
          action,
          comment,
          targets: [...selectedTargets],
          edits,
          commandId: crypto.randomUUID(),
        });
        if (res.next_review) toast('已提交下一级审核', `第 ${res.next_review.level} 级任务已创建`, 'ok');
        else if (action === 'approve') toast('审核通过', '工作流已恢复，继续执行下游节点', 'ok');
        else toast('已退回', `目标：${res.target_nodes.join('、')}；工作流已恢复`, 'ok');
        setTimeout(() => { location.hash = '#/review'; }, 900);
      } catch (error) {
        toast('提交失败', error.message, 'bad');
        button.disabled = false;
        button.textContent = '提交决策';
      }
    };

    return {};
  },
};
