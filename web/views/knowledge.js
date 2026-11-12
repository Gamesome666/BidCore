// 企业知识库（四库）：方案模板 / 工具资产 / 公司资质 / 人员资质 —— 搜索、增删改、有效期预警。
import { api } from '../lib/api.js';
import {
  $, $$, escapeHtml, pill, emptyState, loading, toast, modal, confirmDialog, fmtDate, debounce,
} from '../lib/ui.js';

const esc = escapeHtml;
const LIBRARIES = [
  { key: 'doc', label: '方案模板', desc: '技术方案章节、方法论与写作范式', mark: '▤' },
  { key: 'tool', label: '工具资产', desc: '产品清单、工具链与交付物样例', mark: '⚒' },
  { key: 'company', label: '公司资质', desc: '资质证书、体系认证与业绩证明', mark: '◈' },
  { key: 'personnel', label: '人员资质', desc: '职称、执业资格与项目履历', mark: '☖' },
];
const CATEGORY_LABEL = {
  case: '案例', template: '模板', method: '方法论', product: '产品', tool: '工具',
  qualification: '资质', cert: '证书', person: '人员', company: '公司', other: '其他',
};
const EXPIRY_WARN_DAYS = 45;

function daysLeft(expiresAt) {
  if (!expiresAt) return null;
  const ts = new Date(expiresAt).getTime();
  if (Number.isNaN(ts)) return null;
  return Math.ceil((ts - Date.now()) / 86400000);
}

function expiryBadge(doc) {
  const days = daysLeft(doc.expires_at);
  if (days === null) return '<span class="tag soft">长期有效</span>';
  if (days < 0) return `<span class="pill bad">已过期 ${Math.abs(days)} 天</span>`;
  if (days <= EXPIRY_WARN_DAYS) return `<span class="pill warn">${days} 天后到期</span>`;
  return `<span class="tag soft">${fmtDate(doc.expires_at)} 到期</span>`;
}

function tagList(tags) {
  const list = String(tags || '').split(/[,，\s]+/).filter(Boolean).slice(0, 6);
  return list.map((t) => `<span class="tag">${esc(t)}</span>`).join('');
}

export default {
  title: '企业知识库',

  async render(root, ctx) {
    const state = {
      library: 'doc',
      keyword: '',
      docs: [],
      loading: true,
      error: '',
      destroyed: false,
    };

    const filtered = () => {
      const kw = state.keyword.trim().toLowerCase();
      return state.docs
        .filter((d) => (d.library || 'doc') === state.library)
        .filter((d) => !kw || [d.title, d.content, d.tags, d.folder, d.category]
          .some((field) => String(field || '').toLowerCase().includes(kw)))
        .sort((a, b) => {
          const da = daysLeft(a.expires_at);
          const db = daysLeft(b.expires_at);
          const rank = (d) => (d === null ? 2 : d < 0 ? 0 : d <= EXPIRY_WARN_DAYS ? 1 : 2);
          return rank(da) - rank(db) || String(a.title).localeCompare(String(b.title), 'zh-CN');
        });
    };

    async function load() {
      try {
        state.docs = await api.knowledge();
        state.error = '';
      } catch (error) {
        state.error = error.message || String(error);
        state.docs = [];
      }
      state.loading = false;
      paint();
    }

    function counts() {
      const map = new Map();
      for (const doc of state.docs) {
        const key = doc.library || 'doc';
        map.set(key, (map.get(key) || 0) + 1);
      }
      return map;
    }

    function card(doc) {
      const days = daysLeft(doc.expires_at);
      const border = days !== null && days < 0 ? 'border-left:3px solid var(--danger)'
        : days !== null && days <= EXPIRY_WARN_DAYS ? 'border-left:3px solid var(--amber)' : '';
      return `<div class="doc-card" style="${border}">
        <div class="flex-between" style="align-items:flex-start;gap:8px;flex-wrap:nowrap">
          <div class="d-title" style="flex:1;min-width:0">${esc(doc.title || '未命名素材')}</div>
          <span style="flex:0 0 auto">${expiryBadge(doc)}</span>
        </div>
        <div class="row wrap" style="gap:5px">
          <span class="tag soft">${esc(CATEGORY_LABEL[doc.category] || doc.category || '未分类')}</span>
          ${doc.folder ? `<span class="tag soft">${esc(doc.folder)}</span>` : ''}
        </div>
        <div class="d-body">${esc(String(doc.content || '').replace(/[#>*`]/g, '').slice(0, 160) || '（无内容）')}</div>
        <div class="row wrap" style="gap:4px">${tagList(doc.tags)}</div>
        <div class="d-foot">
          <span class="hint fs11">${doc.created_at ? `建 ${fmtDate(doc.created_at)}` : ''}</span>
          <div class="row right" style="gap:4px">
            <button class="btn xs" data-edit="${esc(doc.id)}">编辑</button>
            <button class="btn xs" data-del="${esc(doc.id)}">删除</button>
          </div>
        </div>
      </div>`;
    }

    function paint() {
      if (state.destroyed) return;
      const map = counts();
      const list = filtered();
      root.innerHTML = `
        <div class="page-head">
          <div>
            <div class="page-title">企业知识库</div>
            <div class="page-desc">四库分离的投标资产：检索 Agent 只返回可溯源命中，缺失的资质/业绩会被质量规则（MAT-01/MAT-02）记为缺陷。</div>
          </div>
          <div class="page-actions">
            <input class="input" id="kb-search" placeholder="搜索标题 / 内容 / 标签…" style="width:240px" value="${esc(state.keyword)}" />
            <button class="btn primary" id="kb-new">＋ 新增素材</button>
          </div>
        </div>
        <div class="tabs">
          ${LIBRARIES.map((lib) => `<button class="tab ${state.library === lib.key ? 'active' : ''}" data-lib="${lib.key}">
            ${lib.mark} ${lib.label}<span class="count">${map.get(lib.key) || 0}</span></button>`).join('')}
        </div>
        <div class="card pad-sm mb12">
          <div class="flex-between">
            <div class="hint fs11">${esc(LIBRARIES.find((l) => l.key === state.library).desc)} · 共 ${list.length} 条</div>
            <div class="hint fs11">有效期 ≤ ${EXPIRY_WARN_DAYS} 天标黄，过期标红 —— 资质过期是废标高发原因</div>
          </div>
        </div>
        ${state.loading
          ? `<div class="card">${loading('加载知识库…')}</div>`
          : state.error
            ? `<div class="card"><div class="card-title">知识库加载失败</div><p class="hint mt8">${esc(state.error)}</p>
                <button class="btn sm mt12" id="kb-reload">重新加载</button></div>`
            : list.length
              ? `<div class="lib-grid">${list.map(card).join('')}</div>`
              : `<div class="card">${emptyState(
                state.keyword ? '没有匹配的素材' : `「${LIBRARIES.find((l) => l.key === state.library).label}」还是空的`,
                state.keyword ? '换个关键词，或清空搜索条件' : '点击右上角「新增素材」录入第一条资产',
                '▦',
              )}</div>`}`;
      bind();
    }

    function openEditor(doc) {
      const item = doc || { library: state.library, category: 'case', folder: '未分类' };
      const libOptions = LIBRARIES.map((lib) => `<option value="${lib.key}" ${String(item.library) === lib.key ? 'selected' : ''}>${lib.label}</option>`).join('');
      const catOptions = Object.entries(CATEGORY_LABEL).map(([key, label]) => `<option value="${key}" ${String(item.category) === key ? 'selected' : ''}>${label}</option>`).join('');
      const expires = item.expires_at ? String(item.expires_at).slice(0, 10) : '';
      const box = modal({
        title: doc ? '编辑素材' : '新增素材',
        wide: true,
        body: `<div class="form-grid">
            <div class="field span2"><label>标题</label><input class="input" id="kb-title" value="${esc(item.title || '')}" placeholder="例：政务云运维技术方案模板" /></div>
            <div class="field"><label>所属库</label><select class="select" id="kb-library">${libOptions}</select></div>
            <div class="field"><label>分类</label><select class="select" id="kb-category">${catOptions}</select></div>
            <div class="field"><label>目录</label><input class="input" id="kb-folder" value="${esc(item.folder || '未分类')}" /></div>
            <div class="field"><label>有效期（可留空=长期）</label><input class="input" id="kb-expires" type="date" value="${esc(expires)}" /></div>
            <div class="field span2"><label>标签（逗号分隔）</label><input class="input" id="kb-tags" value="${esc(item.tags || '')}" placeholder="运维,政务云,7x24" /></div>
            <div class="field span2"><label>内容</label>
              <textarea class="textarea" id="kb-content" style="min-height:180px" placeholder="可直接粘贴 Markdown；检索 Agent 会按段落命中并给出引用">${esc(item.content || '')}</textarea></div>
          </div>`,
        footer: `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="kb-save">${doc ? '保存' : '创建'}</button>`,
      });
      $('#kb-save', box.root).onclick = async (event) => {
        const button = event.currentTarget;
        const title = $('#kb-title', box.root).value.trim();
        if (!title) { toast('请填写标题', '', 'warn'); return; }
        const body = {
          title,
          library: $('#kb-library', box.root).value,
          category: $('#kb-category', box.root).value,
          folder: $('#kb-folder', box.root).value.trim() || '未分类',
          tags: $('#kb-tags', box.root).value.trim(),
          expires_at: $('#kb-expires', box.root).value || null,
          expiresAt: $('#kb-expires', box.root).value || null, // 服务端读 camelCase
          content: $('#kb-content', box.root).value,
        };
        button.disabled = true;
        try {
          const saved = await api.saveKnowledge(doc ? { ...body, id: item.id } : body);
          box.close();
          toast(doc ? '素材已保存' : '素材已创建', title, 'ok');
          if (doc) {
            const idx = state.docs.findIndex((d) => d.id === item.id);
            if (idx >= 0) state.docs[idx] = { ...state.docs[idx], ...body, ...(saved || {}) };
          } else if (saved?.id) {
            state.docs.push({ ...body, ...saved });
          }
          if (saved && body.library && saved.library && saved.library !== body.library) {
            toast('库归属未生效', '服务端当前按分类推断 library，可稍后重试', 'warn');
          }
          paint();
        } catch (error) {
          button.disabled = false;
          toast('保存失败', `${error.code || ''} ${error.message || ''}`.trim(), 'bad');
        }
      };
    }

    function bind() {
      $$('[data-lib]', root).forEach((button) => {
        button.onclick = () => { state.library = button.dataset.lib; paint(); };
      });
      const search = $('#kb-search', root);
      if (search) {
        search.oninput = debounce(() => {
          state.keyword = search.value;
          const active = document.activeElement === search;
          paint();
          if (active) { const next = $('#kb-search', root); next.focus(); next.setSelectionRange(next.value.length, next.value.length); }
        }, 220);
        search.onkeydown = (event) => { if (event.key === 'Enter') { state.keyword = search.value; paint(); } };
      }
      const fresh = $('#kb-new', root);
      if (fresh) fresh.onclick = () => openEditor(null);
      const reload = $('#kb-reload', root);
      if (reload) reload.onclick = () => { state.loading = true; paint(); load(); };
      $$('[data-edit]', root).forEach((button) => {
        button.onclick = () => openEditor(state.docs.find((d) => String(d.id) === button.dataset.edit));
      });
      $$('[data-del]', root).forEach((button) => {
        button.onclick = async () => {
          const doc = state.docs.find((d) => String(d.id) === button.dataset.del);
          if (!doc) return;
          if (!(await confirmDialog(`删除「${doc.title}」？该操作不可撤销。`, { danger: true, okText: '删除' }))) return;
          try {
            await api.deleteKnowledge(doc.id);
            state.docs = state.docs.filter((d) => String(d.id) !== String(doc.id));
            paint();
            toast('已删除', doc.title, 'ok');
          } catch (error) {
            toast('删除失败', error.message || String(error), 'bad');
          }
        };
      });
    }

    paint();
    await load();

    return {
      refresh: () => { load().catch((error) => toast('刷新失败', error.message, 'bad')); },
      destroy: () => { state.destroyed = true; },
    };
  },
};
