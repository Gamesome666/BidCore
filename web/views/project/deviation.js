// 响应偏离：条款 / 招标要求 / 响应 / 偏离 / 证据，行内编辑失焦保存 + 人工确认
import {
  $, escapeHtml, pill, emptyState, toast, confirmDialog, fmtDateTime,
} from '../../lib/ui.js';
import { patchDeviationRow, confirmDeviation, generateDeviation } from './data.js';

const DEVIATION_OPTIONS = ['无偏离', '正偏离', '负偏离', '待确认'];

function statusPill(deviation) {
  if (deviation.status === 'confirmed') return pill('已确认', 'ok');
  if (deviation.status === 'confirmed-local') return pill('已确认（本地）', 'warn');
  return deviation.generated ? pill('草稿', 'warn') : pill('未生成', 'plain');
}

export default async function mount(container, host) {
  let disposed = false;
  let busy = false;

  const deviation = () => host.deviation;
  const locked = () => deviation().status === 'confirmed' || deviation().status === 'confirmed-local';

  function paint() {
    if (disposed) return;
    const view = deviation();
    const rows = view.rows || [];
    const responded = rows.filter((row) => row.response).length;
    const risky = rows.filter((row) => row.deviation === '负偏离' || (row.response && row.response !== '满足' && row.deviation !== '无偏离')).length;

    container.innerHTML = `
      <div class="row wrap mb12" style="gap:10px">
        <div class="fs12 muted">条款 <b class="ink num">${rows.length}</b> · 已填写 <b class="ink num">${responded}</b>
          · 负偏离 <b class="${risky ? 'danger-text' : 'ink'} num">${risky}</b> ${statusPill(view)}</div>
        <div class="right row" style="gap:6px">
          <button class="btn sm" data-gen ${busy ? 'disabled' : ''}>生成 / 重建</button>
          <button class="btn primary sm" data-confirm ${locked() || !rows.length ? 'disabled' : ''}>确认偏离表</button>
        </div>
      </div>
      <div class="wb-banner mb12"><i>◆</i><span>${locked()
    ? '偏离表已确认并锁定，导出校验以此版本为准；如需修改请重新生成。'
    : '逐行填写响应结论（如「满足」「部分满足，见第 3 章」）；确认后锁定，未确认时导出会被阻断。'}</span></div>
      ${view.local || view.status === 'confirmed-local' ? `<div class="wb-banner warn mb12"><i>◆</i><span>偏离表接口未实现，本表由招标解析条目推导，编辑与确认记录保存在本机草稿（导出校验同样认可该本地状态）。</span></div>` : ''}
      ${rows.length ? `<div class="card flush">
        <div class="table-wrap" style="max-height:calc(100vh - 320px)">
          <table class="table compact">
            <thead><tr>
              <th style="width:110px">条款</th><th style="width:34%">招标要求</th>
              <th style="width:200px">响应</th><th style="width:120px">偏离</th><th>证据 / 说明</th>
            </tr></thead>
            <tbody>
              ${rows.map((row) => `<tr data-row="${escapeHtml(row.id)}" class="${row.deviation === '负偏离' ? 'risk-row' : ''}">
                <td class="mono fs11">${escapeHtml(row.clause || row.id)}</td>
                <td>${escapeHtml(row.requirement)}</td>
                <td>
                  <input class="input" style="height:29px;font-size:12px" title="${escapeHtml(row.response || '')}" data-field="response" data-id="${escapeHtml(row.id)}"
                    value="${escapeHtml(row.response || '')}" placeholder="满足 / 部分满足…" ${locked() ? 'disabled' : ''} />
                </td>
                <td>
                  <select class="select" style="height:29px;font-size:12px" data-field="deviation" data-id="${escapeHtml(row.id)}" ${locked() ? 'disabled' : ''}>
                    <option value="" ${!row.deviation ? 'selected' : ''}>未判定</option>
                    ${DEVIATION_OPTIONS.map((option) => `<option value="${escapeHtml(option)}" ${row.deviation === option ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
                  </select>
                </td>
                <td class="fs11 muted" style="overflow-wrap:anywhere">${escapeHtml(row.evidence || '—')}
                  <span data-saved="${escapeHtml(row.id)}" class="pill plain" hidden>已保存</span>
                  ${row.local ? '<span class="pill warn">本地</span>' : ''}
                </td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>` : `<div class="card">${emptyState('偏离表为空', '先完成招标解析，或点击「生成 / 重建」按技术/商务条款推导', '⇄')}
        <div class="row" style="justify-content:center"><button class="btn primary sm" data-gen>生成 / 重建</button></div></div>`}
      ${view.updatedAt ? `<div class="hint mt8">最近更新 ${escapeHtml(fmtDateTime(view.updatedAt))}</div>` : ''}`;

    for (const node of container.querySelectorAll('[data-gen]')) node.onclick = generate;
    const confirmButton = container.querySelector('[data-confirm]');
    if (confirmButton) confirmButton.onclick = confirmTable;

    for (const field of container.querySelectorAll('[data-field]')) {
      field.addEventListener('change', async () => {
        const id = field.dataset.id;
        const row = rows.find((item) => item.id === id);
        if (!row) return;
        const patch = field.dataset.field === 'response' ? { response: field.value } : { deviation: field.value };
        if (field.dataset.field === 'response') row.response = field.value; else row.deviation = field.value;
        const savedTag = container.querySelector(`[data-saved="${CSS.escape(id)}"]`);
        try {
          const result = await patchDeviationRow(host.pid, id, patch);
          row.local = result.mode === 'local';
          if (savedTag) {
            savedTag.hidden = false;
            savedTag.textContent = result.mode === 'local' ? '本地已存' : '已保存';
            savedTag.className = `pill ${result.mode === 'local' ? 'warn' : 'ok'}`;
            setTimeout(() => { if (savedTag.isConnected) savedTag.hidden = true; }, 2400);
          }
        } catch (error) {
          toast('保存失败', error?.message || String(error), 'bad');
        }
      });
    }
  }

  async function generate() {
    if (busy) return;
    busy = true;
    paint();
    try {
      const result = await generateDeviation(host.pid);
      await host.reload();
      if (disposed) return;
      toast(result.mode === 'local' ? '已按解析结果重建偏离表' : '偏离表已生成',
        result.mode === 'local' ? '生成接口未实现，行数据来自招标解析条目' : '', result.mode === 'local' ? 'warn' : 'ok');
    } catch (error) {
      if (disposed) return;
      toast('生成失败', error?.message || String(error), 'bad');
      busy = false;
      paint();
    }
  }

  async function confirmTable() {
    const ok = await confirmDialog('确认偏离表后将锁定编辑，导出校验以此版本为准。确认提交？', { okText: '确认偏离表' });
    if (!ok) return;
    try {
      const result = await confirmDeviation(host.pid);
      await host.reload();
      if (disposed) return;
      toast(result.mode === 'local' ? '偏离表已确认（本地记录）' : '偏离表已确认',
        result.mode === 'local' ? '确认接口未实现，状态保存在本机草稿' : '', result.mode === 'local' ? 'warn' : 'ok');
    } catch (error) {
      toast('确认失败', error?.message || String(error), 'bad');
    }
  }

  paint();
  return { refresh() { paint(); }, destroy() { disposed = true; } };
}


