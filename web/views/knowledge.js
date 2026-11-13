// 企业知识库（四库）：方案模板 / 工具资产 / 公司资质 / 人员资质。
// 能力：搜索、增删改、有效期预警、资料上传（拖拽/多选）、原件预览与下载、附件管理与重解析。
import { api, store } from '../lib/api.js';
import {
  $, $$, escapeHtml, pill, emptyState, loading, toast, modal, confirmDialog,
  fmtDate, fmtBytes, debounce, downloadFile,
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
const DEFAULT_CATEGORY = { doc: 'case', tool: 'product', company: 'qualification', personnel: 'cert' };
const ACCEPT = '.docx,.pdf,.md,.txt,.csv,.xlsx,.png,.jpg,.jpeg,.webp,.gif,.bmp';
const MAX_FILE_MB = 25;
const MAX_TOTAL_MB = 60;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);

// 解析状态 → 卡片徽标（与服务端 meta.parse.status 对齐）
const PARSE_META = {
  ok: ['已抽取', 'ok'],
  empty: ['无文本', 'warn'],
  unsupported: ['不支持', ''],
  image: ['图片', 'info'],
  error: ['解析失败', 'bad'],
};

const extOf = (name) => {
  const match = /\.[^.]+$/.exec(String(name || ''));
  return match ? match[0].toLowerCase() : '';
};
const extOfFile = (file) => String(file?.ext || extOf(file?.name)).toLowerCase();
const isImageFile = (file) => IMAGE_EXT.has(extOfFile(file));
const isPdfFile = (file) => extOfFile(file) === '.pdf';
const filesOf = (doc) => (Array.isArray(doc?.files) ? doc.files : Array.isArray(doc?.meta?.files) ? doc.meta.files : []);
const parseOf = (doc) => doc?.parse || doc?.meta?.parse || null;

function shortName(name, max = 18) {
  const text = String(name || '未命名文件');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

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

function parseBadge(doc) {
  const parse = parseOf(doc);
  if (!parse?.status) return '';
  const [base, kind] = PARSE_META[parse.status] || [parse.status, ''];
  let label = base;
  if (parse.status === 'ok') label = `已抽取 ${parse.chars || 0} 字`;
  else if (parse.status === 'empty') label = parse.kind === 'pdf' ? '扫描件/无文本' : '无文本';
  else if (parse.status === 'image') label = '图片原件';
  return pill(label, kind);
}

function parseNote(doc) {
  const parse = parseOf(doc);
  if (!parse) return '';
  const bits = [
    parse.note,
    parse.pages ? `${parse.pages} 页` : '',
    parse.chars ? `${parse.chars} 字` : '',
  ].filter(Boolean);
  return bits.join(' · ');
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
      thumbUrls: [],
      paintSeq: 0,
    };

    const filtered = () => {
      const kw = state.keyword.trim().toLowerCase();
      return state.docs
        .filter((d) => (d.library || 'doc') === state.library)
        .filter((d) => !kw || [
          d.title, d.content, d.tags, d.folder, d.category,
          filesOf(d).map((f) => f.name).join(' '),
        ].some((field) => String(field || '').toLowerCase().includes(kw)))
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

    function revokeThumbs() {
      for (const url of state.thumbUrls) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      }
      state.thumbUrls = [];
    }

    /** 图片缩略图：附件的 <img> 必须带 ?token=，用 fetch→blob 避免 token 泄漏到 DOM 历史里 */
    function loadThumbs() {
      const seq = state.paintSeq;
      for (const img of $$('[data-kb-img]', root)) {
        const [docId, fileId] = String(img.dataset.kbImg || '').split(':');
        if (!docId || !fileId) continue;
        fetch(api.knowledgeFileUrl(docId, fileId))
          .then((res) => (res.ok ? res.blob() : null))
          .then((blob) => {
            if (!blob || state.destroyed || seq !== state.paintSeq) return;
            const url = URL.createObjectURL(blob);
            state.thumbUrls.push(url);
            img.src = url;
          })
          .catch(() => { /* 缩略图失败不影响卡片 */ });
      }
    }

    function card(doc) {
      const days = daysLeft(doc.expires_at);
      const border = days !== null && days < 0 ? 'border-left:3px solid var(--danger)'
        : days !== null && days <= EXPIRY_WARN_DAYS ? 'border-left:3px solid var(--amber)' : '';
      const files = filesOf(doc);
      const imageFile = files.find(isImageFile);
      const chips = files.slice(0, 3).map((file) => `<button class="kb-file-chip" data-preview="${esc(doc.id)}" data-file="${esc(file.id)}" title="预览 ${esc(file.name)}">
        ${isImageFile(file) ? '🖼' : '📎'} ${esc(shortName(file.name))}</button>`).join('');
      return `<div class="doc-card kb-card" style="${border}">
        <div class="flex-between" style="align-items:flex-start;gap:8px;flex-wrap:nowrap">
          <div class="d-title" style="flex:1;min-width:0">${esc(doc.title || '未命名素材')}</div>
          <span style="flex:0 0 auto">${expiryBadge(doc)}</span>
        </div>
        <div class="row wrap" style="gap:5px">
          <span class="tag soft">${esc(CATEGORY_LABEL[doc.category] || doc.category || '未分类')}</span>
          ${doc.folder ? `<span class="tag soft">${esc(doc.folder)}</span>` : ''}
          ${files.length ? `<span class="tag soft kb-file-badge">📎 ${files.length} 个文件</span>` : ''}
          ${parseBadge(doc)}
        </div>
        ${imageFile ? `<div class="kb-thumb-wrap">
          <img class="kb-thumb" data-kb-img="${esc(doc.id)}:${esc(imageFile.id)}" alt="${esc(imageFile.name)}" />
        </div>` : ''}
        <div class="d-body">${esc(String(doc.content || '').replace(/[#>*`]/g, '').slice(0, 160) || '（无内容）')}</div>
        <div class="row wrap" style="gap:4px">${tagList(doc.tags)}</div>
        ${chips ? `<div class="kb-files-row">${chips}${files.length > 3 ? `<span class="tag soft">+${files.length - 3}</span>` : ''}</div>` : ''}
        ${parseNote(doc) ? `<div class="hint fs11 kb-parse-note">${esc(parseNote(doc))}</div>` : ''}
        <div class="d-foot">
          <span class="hint fs11">${doc.created_at ? `建 ${fmtDate(doc.created_at)}` : ''}</span>
          <div class="row right" style="gap:4px">
            ${files.length ? `<button class="btn xs" data-reparse="${esc(doc.id)}">重解析</button>` : ''}
            <button class="btn xs" data-edit="${esc(doc.id)}">编辑</button>
            <button class="btn xs" data-del="${esc(doc.id)}">删除</button>
          </div>
        </div>
      </div>`;
    }

    function paint() {
      if (state.destroyed) return;
      state.paintSeq += 1;
      revokeThumbs();
      const map = counts();
      const list = filtered();
      const lib = LIBRARIES.find((l) => l.key === state.library) || LIBRARIES[0];
      root.innerHTML = `
        <div class="page-head">
          <div>
            <div class="page-title">企业知识库</div>
            <div class="page-desc">四库分离的投标资产：检索 Agent 只返回可溯源命中，缺失的资质/业绩会被质量规则（MAT-01/MAT-02）记为缺陷。</div>
          </div>
          <div class="page-actions">
            <input class="input" id="kb-search" placeholder="搜索标题 / 内容 / 标签 / 文件名…" style="width:240px" value="${esc(state.keyword)}" />
            <button class="btn accent" id="kb-upload">⬆ 上传资料</button>
            <button class="btn primary" id="kb-new">＋ 新增素材</button>
          </div>
        </div>
        <div class="tabs">
          ${LIBRARIES.map((item) => `<button class="tab ${state.library === item.key ? 'active' : ''}" data-lib="${item.key}">
            ${item.mark} ${item.label}<span class="count">${map.get(item.key) || 0}</span></button>`).join('')}
        </div>
        <div class="card pad-sm mb12">
          <div class="flex-between">
            <div class="hint fs11">${esc(lib.desc)} · 共 ${list.length} 条</div>
            <div class="hint fs11">支持 DOCX / PDF / XLSX / TXT / MD / CSV / 图片 · 单文件 ≤ ${MAX_FILE_MB}MB · 单次 ≤ ${MAX_TOTAL_MB}MB · 也可把文件直接拖进本页</div>
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
                state.keyword ? '没有匹配的素材' : `「${lib.label}」还是空的`,
                state.keyword ? '换个关键词，或清空搜索条件' : '点击右上角「上传资料」把 Word/PDF/证书照片导进来',
                '▦',
              )}</div>`}
        <div class="kb-drop-overlay" id="kb-drop-overlay"><div>松开鼠标，上传到企业知识库</div></div>`;
      bind();
      loadThumbs();
    }

    /* ─────────────────────────── 预览弹层 ─────────────────────────── */
    function openPreview(doc, file) {
      if (!doc || !file) return;
      const url = api.knowledgeFileUrl(doc.id, file.id);
      const downloadUrl = api.knowledgeFileUrl(doc.id, file.id, { download: true });
      const parse = parseOf(doc);
      const viewer = isImageFile(file)
        ? `<img class="kb-preview-img" src="${esc(url)}" alt="${esc(file.name)}" />`
        : isPdfFile(file)
          ? `<iframe class="kb-preview-frame" src="${esc(url)}" title="${esc(file.name)}"></iframe>`
          : `<div class="hint mb8">该格式不支持内嵌预览，可下载原件查看；下方是服务端解析出的正文。</div>`;
      const body = `
        ${viewer}
        <div class="flex-between mt12">
          <div class="card-title fs13">解析正文</div>
          <span class="hint fs11">${esc(parse?.status || '未解析')} · ${Number(parse?.chars || 0)} 字${parse?.pages ? ` · ${parse.pages} 页` : ''}</span>
        </div>
        <pre class="kb-preview-text">${esc(String(doc.content || '').slice(0, 6000) || '（暂无解析文本，请手动补充摘要）')}</pre>`;
      const box = modal({
        title: file.name,
        wide: true,
        body,
        footer: `<button class="btn" data-modal-close>关闭</button><button class="btn primary" id="kb-preview-dl">下载原件</button>`,
      });
      $('#kb-preview-dl', box.root).onclick = () => downloadFile(downloadUrl, file.name);
    }

    /* ─────────────────────────── 上传弹窗 ─────────────────────────── */
    function openUpload(initialFiles = [], targetDoc = null) {
      const isAppend = Boolean(targetDoc);
      const defaultCategory = DEFAULT_CATEGORY[state.library] || 'case';
      const libOptions = LIBRARIES.map((lib) => `<option value="${lib.key}" ${lib.key === state.library ? 'selected' : ''}>${lib.label}</option>`).join('');
      const catOptions = Object.entries(CATEGORY_LABEL).map(([key, label]) => `<option value="${key}" ${key === defaultCategory ? 'selected' : ''}>${label}</option>`).join('');
      const box = modal({
        title: isAppend ? `追加附件 · ${targetDoc.title}` : '上传企业资料',
        wide: true,
        body: `
          ${isAppend
            ? `<div class="hint mb12">新文件会和已有 ${filesOf(targetDoc).length} 个附件一起重新解析，并覆盖当前正文。</div>`
            : `<div class="form-grid">
                <div class="field"><label>所属库</label><select class="select" id="kb-u-library">${libOptions}</select></div>
                <div class="field"><label>分类</label><select class="select" id="kb-u-category">${catOptions}</select></div>
                <div class="field"><label>目录</label><input class="input" id="kb-u-folder" value="资料上传" /></div>
                <div class="field"><label>有效期（可留空 = 长期）</label><input class="input" id="kb-u-expires" type="date" /></div>
                <div class="field span2"><label>标签（逗号分隔）</label><input class="input" id="kb-u-tags" placeholder="资质,证书,扫描件" /></div>
              </div>`}
          <div class="kb-upload-drop" id="kb-u-drop">
            <div>把文件拖到这里，或 <button class="btn sm" type="button" id="kb-u-pick">选择文件</button></div>
            <div class="hint fs11 mt4">支持 DOCX / PDF / XLSX / TXT / MD / CSV / 图片 · 单文件 ≤ ${MAX_FILE_MB}MB</div>
            <input type="file" id="kb-u-input" accept="${ACCEPT}" multiple hidden />
          </div>
          <div class="kb-filelist" id="kb-u-list"></div>
          <div class="hint fs11 mt8" id="kb-u-hint">逐个文件创建素材；Word/PDF 自动抽取正文，图片保存原件并提示补充摘要。</div>`,
        footer: `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="kb-u-submit">${isAppend ? '追加并重解析' : '开始上传'}</button>`,
      });

      let queue = [...initialFiles];
      const listEl = $('#kb-u-list', box.root);
      const librarySelect = $('#kb-u-library', box.root);
      const categorySelect = $('#kb-u-category', box.root);
      if (librarySelect && categorySelect) {
        librarySelect.onchange = () => {
          categorySelect.value = DEFAULT_CATEGORY[librarySelect.value] || 'case';
        };
      }

      const totalBytes = () => queue.reduce((sum, file) => sum + Number(file.size || 0), 0);

      function renderQueue() {
        listEl.innerHTML = queue.map((file, index) => `<div class="kb-file-row">
          <span class="kb-file-mark">${IMAGE_EXT.has(extOf(file.name)) ? '🖼' : '📄'}</span>
          <span class="fname" title="${esc(file.name)}">${esc(file.name)}</span>
          <span class="hint fs11">${fmtBytes(file.size)}</span>
          <button class="btn xs" type="button" data-kb-remove="${index}">移除</button>
        </div>`).join('') || '<div class="hint fs11">还没有选择文件</div>';
        $$('[data-kb-remove]', listEl).forEach((button) => {
          button.onclick = () => {
            queue.splice(Number(button.dataset.kbRemove), 1);
            renderQueue();
          };
        });
        $('#kb-u-hint', box.root).textContent = queue.length
          ? `已选 ${queue.length} 个文件 · 合计 ${fmtBytes(totalBytes())}${totalBytes() > MAX_TOTAL_MB * 1024 * 1024 ? ' · 超过单次 60MB，服务端会拒绝' : ''}`
          : '逐个文件创建素材；Word/PDF 自动抽取正文，图片保存原件并提示补充摘要。';
      }

      const addFiles = (files) => {
        for (const file of files || []) queue.push(file);
        renderQueue();
      };

      const input = $('#kb-u-input', box.root);
      $('#kb-u-pick', box.root).onclick = () => input.click();
      input.onchange = () => { addFiles([...input.files]); input.value = ''; };

      const drop = $('#kb-u-drop', box.root);
      drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('active'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('active'));
      drop.addEventListener('drop', (event) => {
        event.preventDefault();
        drop.classList.remove('active');
        addFiles([...(event.dataTransfer?.files || [])]);
      });

      // 弹窗挂在 #modal-root（不在 #view 内），页面级 drop 拦不住；这里临时兜底，
      // 防止把文件松到弹窗空白处时浏览器直接打开本地文件。
      const zone = drop;
      const inZone = (target) => zone.contains(target);
      const docOver = (event) => { if (!inZone(event.target) && hasFiles(event)) event.preventDefault(); };
      const docDrop = (event) => {
        if (inZone(event.target) || !hasFiles(event)) return;
        event.preventDefault();
        addFiles([...(event.dataTransfer?.files || [])]);
      };
      document.addEventListener('dragover', docOver, true);
      document.addEventListener('drop', docDrop, true);
      const modalRoot = document.getElementById('modal-root');
      const watcher = new MutationObserver(() => {
        if (modalRoot.querySelector('.modal-mask')) return;
        document.removeEventListener('dragover', docOver, true);
        document.removeEventListener('drop', docDrop, true);
        watcher.disconnect();
      });
      watcher.observe(modalRoot, { childList: true });

      $('#kb-u-submit', box.root).onclick = async (event) => {
        const button = event.currentTarget;
        if (!queue.length) { toast('请先选择文件', '', 'warn'); return; }
        const form = new FormData();
        if (!isAppend) {
          const fields = {
            library: $('#kb-u-library', box.root).value,
            category: $('#kb-u-category', box.root).value,
            folder: $('#kb-u-folder', box.root).value.trim(),
            tags: $('#kb-u-tags', box.root).value.trim(),
            expiresAt: $('#kb-u-expires', box.root).value || '',
          };
          for (const [key, value] of Object.entries(fields)) if (value) form.append(key, value);
        }
        for (const file of queue) form.append('files', file, file.name || 'file');

        button.disabled = true;
        button.textContent = isAppend ? '上传并重解析…' : '上传中…';
        try {
          if (isAppend) {
            const result = await api.appendKnowledgeFiles(targetDoc.id, form);
            box.close();
            toast('附件已追加', `新增 ${result.added?.length || 0} 个 · 正文 ${result.document?.parse?.chars || 0} 字`, 'ok');
          } else {
            const result = await api.uploadKnowledge(form);
            box.close();
            const created = result.documents?.length || 0;
            const failed = result.failed?.length || 0;
            toast(
              '上传完成',
              `${created} 个素材已入库${failed ? `，${failed} 个失败` : ''}`,
              failed ? 'warn' : 'ok',
            );
          }
          await load();
        } catch (error) {
          button.disabled = false;
          button.textContent = isAppend ? '追加并重解析' : '开始上传';
          toast('上传失败', `${error.code || ''} ${error.message || error}`.trim(), 'bad');
        }
      };

      renderQueue();
    }

    /* ─────────────────────────── 编辑弹窗 ─────────────────────────── */
    function openEditor(doc) {
      let item = doc
        ? { ...doc }
        : { library: state.library, category: DEFAULT_CATEGORY[state.library] || 'case', folder: '未分类', content: '', tags: '' };
      let pending = [];
      const libOptions = LIBRARIES.map((lib) => `<option value="${lib.key}" ${String(item.library) === lib.key ? 'selected' : ''}>${lib.label}</option>`).join('');
      const catOptions = Object.entries(CATEGORY_LABEL).map(([key, label]) => `<option value="${key}" ${String(item.category) === key ? 'selected' : ''}>${label}</option>`).join('');
      const expires = item.expires_at ? String(item.expires_at).slice(0, 10) : '';
      const existing = filesOf(item);

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
            ${doc ? `<div class="field span2">
              <div class="flex-between" style="gap:8px">
                <label style="margin:0">附件（${existing.length}）</label>
                ${existing.length ? '<button class="btn xs" type="button" id="kb-reparse">重解析正文</button>' : ''}
              </div>
              <div class="kb-filelist" id="kb-attach-list"></div>
              <div class="row mt8" style="gap:8px">
                <button class="btn sm" type="button" id="kb-attach-add">＋ 添加附件</button>
                <span class="hint fs11">保存时上传并重解析</span>
                <input type="file" id="kb-attach-input" accept="${ACCEPT}" multiple hidden />
              </div>
            </div>` : ''}
            <div class="field span2"><label>内容</label>
              <textarea class="textarea" id="kb-content" style="min-height:180px" placeholder="可直接粘贴 Markdown；检索 Agent 会按段落命中并给出引用">${esc(item.content || '')}</textarea></div>
          </div>`,
        footer: `<button class="btn" data-modal-close>取消</button><button class="btn primary" id="kb-save">${doc ? '保存' : '创建'}</button>`,
      });

      const editorLibrary = $('#kb-library', box.root);
      const editorCategory = $('#kb-category', box.root);
      if (editorLibrary && editorCategory) {
        editorLibrary.onchange = () => {
          editorCategory.value = DEFAULT_CATEGORY[editorLibrary.value] || 'case';
        };
      }

      function renderAttachments() {
        const holder = $('#kb-attach-list', box.root);
        if (!holder) return;
        const rows = [
          ...filesOf(item).map((file) => `<div class="kb-file-row">
            <span class="kb-file-mark">${isImageFile(file) ? '🖼' : '📄'}</span>
            <span class="fname" title="${esc(file.name)}">${esc(file.name)}</span>
            <span class="hint fs11">${fmtBytes(file.bytes)}</span>
            <button class="btn xs" type="button" data-file-preview="${esc(file.id)}">预览</button>
            <button class="btn xs" type="button" data-file-del="${esc(file.id)}">删除</button>
          </div>`),
          ...pending.map((file, index) => `<div class="kb-file-row">
            <span class="kb-file-mark">${IMAGE_EXT.has(extOf(file.name)) ? '🖼' : '📄'}</span>
            <span class="fname" title="${esc(file.name)}">${esc(file.name)}</span>
            <span class="hint fs11">${fmtBytes(file.size)} · 待上传</span>
            <button class="btn xs" type="button" data-pending-remove="${index}">移除</button>
          </div>`),
        ];
        holder.innerHTML = rows.join('') || '<div class="hint fs11">暂无附件</div>';

        $$('[data-file-preview]', holder).forEach((button) => {
          button.onclick = () => {
            const file = filesOf(item).find((f) => String(f.id) === button.dataset.filePreview);
            if (!file) return;
            // 编辑弹窗复用 #modal-root，不能再叠一层 modal；原件带 token 直接新标签打开
            window.open(api.knowledgeFileUrl(item.id, file.id), '_blank', 'noopener');
          };
        });
        $$('[data-pending-remove]', holder).forEach((button) => {
          button.onclick = () => {
            pending.splice(Number(button.dataset.pendingRemove), 1);
            renderAttachments();
          };
        });
        $$('[data-file-del]', holder).forEach((button) => {
          button.onclick = async () => {
            const file = filesOf(item).find((f) => String(f.id) === button.dataset.fileDel);
            if (!file) return;
            // confirmDialog 会占用 #modal-root 把编辑弹窗冲掉，这里用两步点击确认
            if (button.dataset.armed !== '1') {
              button.dataset.armed = '1';
              button.textContent = '确认删除？';
              button.classList.add('danger');
              setTimeout(() => {
                if (button.isConnected && button.dataset.armed === '1') {
                  button.dataset.armed = '';
                  button.textContent = '删除';
                  button.classList.remove('danger');
                }
              }, 3000);
              return;
            }
            button.disabled = true;
            try {
              const result = await api.deleteKnowledgeFile(item.id, file.id);
              item = { ...item, ...(result.document || {}) };
              $('#kb-content', box.root).value = item.content || '';
              renderAttachments();
              toast('附件已删除', file.name, 'ok');
            } catch (error) {
              button.disabled = false;
              toast('删除失败', error.message || String(error), 'bad');
            }
          };
        });
      }

      if (doc) {
        renderAttachments();
        $('#kb-attach-add', box.root).onclick = () => $('#kb-attach-input', box.root).click();
        $('#kb-attach-input', box.root).onchange = (event) => {
          pending.push(...event.target.files);
          event.target.value = '';
          renderAttachments();
        };
        const reparse = $('#kb-reparse', box.root);
        if (reparse) {
          reparse.onclick = async () => {
            reparse.disabled = true;
            try {
              const result = await api.reparseKnowledge(item.id);
              item = { ...item, ...(result.document || {}) };
              $('#kb-content', box.root).value = item.content || '';
              renderAttachments();
              toast('已重解析', `${item.parse?.chars || 0} 字`, 'ok');
            } catch (error) {
              toast('重解析失败', `${error.code || ''} ${error.message || error}`.trim(), 'bad');
            } finally {
              reparse.disabled = false;
            }
          };
        }
      }

      $('#kb-save', box.root).onclick = async (event) => {
        const button = event.currentTarget;
        const title = $('#kb-title', box.root).value.trim();
        if (!title) { toast('请填写标题', '', 'warn'); return; }
        const expiresAt = $('#kb-expires', box.root).value || '';
        const body = {
          title,
          library: $('#kb-library', box.root).value,
          category: $('#kb-category', box.root).value,
          folder: $('#kb-folder', box.root).value.trim() || '未分类',
          tags: $('#kb-tags', box.root).value.trim(),
          expires_at: expiresAt,
          expiresAt, // 服务端优先读 camelCase；空串用于清空有效期
          content: $('#kb-content', box.root).value,
        };
        button.disabled = true;
        try {
          await api.saveKnowledge(doc ? { ...body, id: item.id } : body);
          if (doc && pending.length) {
            const form = new FormData();
            for (const file of pending) form.append('files', file, file.name || 'file');
            await api.appendKnowledgeFiles(item.id, form);
          }
          box.close();
          toast(doc ? '素材已保存' : '素材已创建', pending.length ? `已追加 ${pending.length} 个附件` : title, 'ok');
          await load();
        } catch (error) {
          button.disabled = false;
          toast('保存失败', `${error.code || ''} ${error.message || ''}`.trim(), 'bad');
        }
      };
    }

    /* ─────────────────────────── 事件绑定 ─────────────────────────── */
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
          if (active) {
            const next = $('#kb-search', root);
            next.focus();
            next.setSelectionRange(next.value.length, next.value.length);
          }
        }, 220);
        search.onkeydown = (event) => { if (event.key === 'Enter') { state.keyword = search.value; paint(); } };
      }
      const fresh = $('#kb-new', root);
      if (fresh) fresh.onclick = () => openEditor(null);
      const upload = $('#kb-upload', root);
      if (upload) upload.onclick = () => openUpload([]);
      const reload = $('#kb-reload', root);
      if (reload) reload.onclick = () => { state.loading = true; paint(); load(); };
      $$('[data-edit]', root).forEach((button) => {
        button.onclick = () => openEditor(state.docs.find((d) => String(d.id) === button.dataset.edit));
      });
      $$('[data-preview]', root).forEach((button) => {
        button.onclick = () => {
          const doc = state.docs.find((d) => String(d.id) === button.dataset.preview);
          const file = filesOf(doc).find((f) => String(f.id) === button.dataset.file);
          openPreview(doc, file);
        };
      });
      $$('[data-reparse]', root).forEach((button) => {
        button.onclick = async () => {
          button.disabled = true;
          button.textContent = '解析中…';
          try {
            const result = await api.reparseKnowledge(button.dataset.reparse);
            toast('已重解析', `${result.document?.parse?.chars || 0} 字`, 'ok');
            await load();
          } catch (error) {
            button.disabled = false;
            button.textContent = '重解析';
            toast('重解析失败', `${error.code || ''} ${error.message || error}`.trim(), 'bad');
          }
        };
      });
      $$('[data-del]', root).forEach((button) => {
        button.onclick = async () => {
          const doc = state.docs.find((d) => String(d.id) === button.dataset.del);
          if (!doc) return;
          const count = filesOf(doc).length;
          const extra = count ? `、「其 ${count} 个附件原件」` : '';
          if (!(await confirmDialog(`删除「${doc.title}」${extra}？该操作不可撤销。`, { danger: true, okText: '删除' }))) return;
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

    /* ─────────────────────────── 整页拖拽上传 ─────────────────────────── */
    let dragDepth = 0;
    const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes('Files');
    const overlay = () => $('#kb-drop-overlay', root);
    const onDragEnter = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      overlay()?.classList.add('active');
    };
    const onDragOver = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) overlay()?.classList.remove('active');
    };
    const onDrop = (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      overlay()?.classList.remove('active');
      const files = [...(event.dataTransfer?.files || [])];
      if (files.length) openUpload(files);
    };
    root.addEventListener('dragenter', onDragEnter);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('dragleave', onDragLeave);
    root.addEventListener('drop', onDrop);

    paint();
    await load();

    return {
      refresh: () => { load().catch((error) => toast('刷新失败', error.message, 'bad')); },
      destroy: () => {
        state.destroyed = true;
        revokeThumbs();
        root.removeEventListener('dragenter', onDragEnter);
        root.removeEventListener('dragover', onDragOver);
        root.removeEventListener('dragleave', onDragLeave);
        root.removeEventListener('drop', onDrop);
      },
    };
  },
};
