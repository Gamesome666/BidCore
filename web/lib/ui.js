// UI 组件库：DOM / 格式化 / 状态徽标 / Markdown / DAG / 雷达 / 迷你图 / Diff / 抽屉 / 弹窗 / Toast。
// 约定：组件函数返回 HTML 字符串，由视图用 innerHTML 注入；交互通过 data-* 属性 + 事件委托绑定。

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/* ---------------------------------------------------------------- 格式化 */
const pad = (n) => String(n).padStart(2, '0');

export function fmtTime(iso, withDate = true) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withDate ? `${d.getMonth() + 1}/${d.getDate()} ${time}` : time;
}

export function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtDateTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtRelative(iso) {
  if (!iso) return '-';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (Math.abs(min) < 1) return '刚刚';
  if (min > 0 && min < 60) return `${min} 分钟前`;
  if (min < 0 && min > -60) return `${-min} 分钟后`;
  const h = Math.round(min / 60);
  if (Math.abs(h) < 24) return h > 0 ? `${h} 小时前` : `${-h} 小时后`;
  return h > 0 ? `${Math.round(h / 24)} 天前` : `${Math.round(-h / 24)} 天后`;
}

export function fmtDuration(ms) {
  if (!ms || ms < 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m${Math.round((ms % 60000) / 1000)}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function fmtBytes(bytes) {
  const n = Number(bytes || 0);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function fmtNum(n, digits = 0) {
  const v = Number(n || 0);
  return v.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function countdown(iso) {
  if (!iso) return '-';
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return '-';
  const abs = Math.abs(ms);
  const h = Math.floor(abs / 3600000);
  const m = Math.floor((abs % 3600000) / 60000);
  const text = h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`;
  return ms >= 0 ? `剩余 ${text}` : `已超时 ${text}`;
}

/* ---------------------------------------------------------------- 状态 */
export const RUN_STATUS = {
  planning: '规划中', running: '运行中', replanning: '重规划', waiting_human: '等待人工',
  paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断',
};
export const NODE_STATUS = {
  pending: '待执行', ready: '就绪', running: '执行中', succeeded: '已完成', failed: '失败',
  waiting_human: '等待人工', invalidated: '已失效', interrupted: '已中断', skipped: '已跳过',
};
export const ACTION_LABEL = { approve: '通过', reject: '驳回', modify: '修改', reanalyze: '要求重新分析' };
export const VERDICT_LABEL = { pass: '质量达标', revise: '需定向返工', regenerate: '重新生成', veto: '触发废标', pending: '待评估' };
export const ROLE_LABEL = {
  admin: '管理员', 'project-owner': '项目负责人', 'user': '指定审核人',
  owner: '项目负责人', tech: '技术负责人', biz: '商务负责人', reviewer: '审核员',
};

const PILL_CLASS = {
  succeeded: 'ok', completed: 'ok', approved: 'ok', pass: 'ok', done: 'ok', confirmed: 'ok', success: 'ok',
  waiting_human: 'warn', paused: 'warn', pending: 'warn', revise: 'warn', review: 'warn', detecting: 'warn',
  ready: 'info', running: 'info', planning: 'info', replanning: 'info', generating: 'info',
  failed: 'bad', cancelled: 'bad', rejected: 'bad', regenerate: 'bad', veto: 'bad', error: 'bad', overdue: 'bad',
  invalidated: 'violet', skipped: 'violet', superseded: 'violet', modified: 'violet', reanalyzed: 'violet',
  empty: '', idle: '',
};

export function pill(label, kind = '', extra = '') {
  return `<span class="pill ${kind} ${extra}">${kind ? '<i class="dot"></i>' : ''}${escapeHtml(label)}</span>`;
}

export function statusPill(status) {
  const label = RUN_STATUS[status] || NODE_STATUS[status] || ACTION_LABEL[status] || VERDICT_LABEL[status] || status || '-';
  return pill(label, PILL_CLASS[status] ?? '');
}

export function verdictPill(verdict) {
  return pill(VERDICT_LABEL[verdict] || verdict || '-', PILL_CLASS[verdict] ?? '');
}

/** 审核任务状态（与节点状态同名但语义不同：pending = 待审核，不是待执行） */
export const REVIEW_STATUS_LABEL = {
  pending: '待审核', in_review: '审核中', approved: '已通过', rejected: '已驳回',
  modified: '已修改', reanalyzed: '已重分析', escalated: '已升级', cancelled: '已取消', closed: '已关闭',
};
export function reviewStatusPill(status) {
  const kind = { pending: 'warn', in_review: 'info', approved: 'ok', rejected: 'bad', modified: 'violet', reanalyzed: 'violet', escalated: 'warn', cancelled: '', closed: '' }[status] ?? '';
  return pill(REVIEW_STATUS_LABEL[status] || status || '-', kind);
}

export function scoreClass(score) {
  if (score === null || score === undefined || score === '') return '';
  const n = Number(score);
  if (n >= 80) return 'ok';
  if (n >= 60) return 'warn';
  return 'bad';
}

export function scoreStyle(score) {
  const n = Number(score || 0);
  return n >= 80 ? 'color:var(--jade)' : n >= 60 ? 'color:var(--amber)' : 'color:var(--danger)';
}

/* ---------------------------------------------------------------- Markdown */
const INLINE = (text) => escapeHtml(text)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

export function markdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let list = null;
  let table = null;
  let code = null;
  let quote = null;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    out.push(`<table><thead><tr>${head.map((c) => `<th>${INLINE(c)}</th>`).join('')}</tr></thead><tbody>`);
    for (const row of rows) out.push(`<tr>${row.map((c) => `<td>${INLINE(c)}</td>`).join('')}</tr>`);
    out.push('</tbody></table>');
    table = null;
  };
  const closeQuote = () => { if (quote) { out.push(`<blockquote>${quote.map(INLINE).join('<br>')}</blockquote>`); quote = null; } };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^```/.test(line)) {
      if (code !== null) { out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = null; }
      else { closeList(); closeTable(); closeQuote(); code = []; }
      continue;
    }
    if (code !== null) { code.push(raw); continue; }

    if (/^\|/.test(line.trim())) {
      closeList(); closeQuote();
      const cells = line.trim().split('|').slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
      (table ||= []).push(cells);
      continue;
    }
    closeTable();

    if (!line.trim()) { closeList(); closeQuote(); continue; }
    if (/^>\s?/.test(line)) { closeList(); (quote ||= []).push(line.replace(/^>\s?/, '')); continue; }
    closeQuote();
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${INLINE(h[2])}</h${h[1].length}>`); continue; }
    if (/^[-*+]\s+/.test(line)) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${INLINE(line.replace(/^[-*+]\s+/, ''))}</li>`);
      continue;
    }
    if (/^\d+[.)]\s+/.test(line)) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${INLINE(line.replace(/^\d+[.)]\s+/, ''))}</li>`);
      continue;
    }
    if (/^---+$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    closeList();
    out.push(`<p>${INLINE(line)}</p>`);
  }
  if (code !== null) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  closeList(); closeTable(); closeQuote();
  return out.join('\n');
}

/* ---------------------------------------------------------------- DAG（纵向分层） */
export function dag(nodes, { selected } = {}) {
  if (!nodes?.length) return emptyState('暂无节点', '启动工作流后这里会显示执行图');
  const NODE_W = 168;
  const NODE_H = 52;
  const GAP_Y = 36;
  const GAP_X = 18;
  const byKey = new Map(nodes.map((n) => [n.node_key, n]));
  const layerOf = new Map();
  const depth = (key, guard = new Set()) => {
    if (layerOf.has(key)) return layerOf.get(key);
    if (guard.has(key)) return 0;
    guard.add(key);
    const node = byKey.get(key);
    const deps = (node?.depends_on || []).filter((d) => byKey.has(d));
    const d = deps.length ? Math.max(...deps.map((x) => depth(x, guard))) + 1 : 0;
    layerOf.set(key, d);
    return d;
  };
  nodes.forEach((n) => depth(n.node_key));
  const layers = new Map();
  for (const node of nodes) {
    const l = layerOf.get(node.node_key) || 0;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l).push(node);
  }
  const maxPerLayer = Math.max(...[...layers.values()].map((v) => v.length));
  const width = Math.max(maxPerLayer * (NODE_W + GAP_X) + 40, 420);
  const height = (Math.max(...layers.keys()) + 1) * (NODE_H + GAP_Y) + 10;
  const pos = new Map();
  for (const [layer, list] of layers) {
    const total = list.length * NODE_W + (list.length - 1) * GAP_X;
    list.forEach((node, i) => {
      pos.set(node.node_key, {
        x: (width - total) / 2 + i * (NODE_W + GAP_X),
        y: 10 + layer * (NODE_H + GAP_Y),
      });
    });
  }
  const edges = [];
  for (const node of nodes) {
    const b = pos.get(node.node_key);
    for (const dep of node.depends_on || []) {
      const a = pos.get(dep);
      if (!a || !b) continue;
      const x1 = a.x + NODE_W / 2;
      const y1 = a.y + NODE_H;
      const x2 = b.x + NODE_W / 2;
      const y2 = b.y;
      const mid = (y1 + y2) / 2;
      const cls = node.status === 'succeeded' ? 'done'
        : ['running', 'ready', 'waiting_human'].includes(node.status) ? 'active' : '';
      edges.push(`<path class="edge ${cls}" d="M${x1},${y1} C${x1},${mid} ${x2},${mid} ${x2},${y2}" />`);
    }
  }
  const shapes = nodes.map((node) => {
    const p = pos.get(node.node_key);
    const score = node.quality_score ? ` · ${node.quality_score}分` : '';
    const status = NODE_STATUS[node.status] || node.status;
    const label = node.node_type === 'human-review' ? '人工审核' : node.node_type === 'quality' ? '质量门禁' : node.node_type === 'export' ? '导出' : node.agent_key;
    return `<g class="dag-node ${node.status} ${selected === node.node_key ? 'selected' : ''}" data-node="${escapeHtml(node.node_key)}" transform="translate(${p.x},${p.y})">
      <rect width="${NODE_W}" height="${NODE_H}" rx="9"></rect>
      <text x="11" y="20" class="node-key">${escapeHtml(label)}</text>
      <text x="11" y="37">${escapeHtml(node.node_key)}${node.iteration ? ` · 第${node.iteration}轮` : ''}</text>
      <text x="${NODE_W - 9}" y="37" text-anchor="end" class="node-badge">${escapeHtml(status)}${score}</text>
    </g>`;
  }).join('');
  return `<div class="dag-wrap"><svg class="dag" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
    <g>${edges.join('')}</g><g>${shapes}</g></svg></div>`;
}

export function bindDag(root, onSelect) {
  for (const node of $$('.dag-node', root)) {
    node.addEventListener('click', () => onSelect?.(node.dataset.node));
  }
}

export function dagLegend() {
  const items = [['pending', '待执行'], ['running', '执行中'], ['waiting_human', '等待人工'], ['succeeded', '已完成'], ['invalidated', '已失效'], ['failed', '失败']];
  const colors = { pending: '#e2ded4', running: '#1c4f9c', waiting_human: '#b8401a', succeeded: '#0f6b5f', invalidated: '#5b3f9e', failed: '#a51d1d' };
  return `<div class="dag-legend">${items.map(([k, label]) => `<span><i style="background:${colors[k]}"></i>${label}</span>`).join('')}</div>`;
}

/* ---------------------------------------------------------------- 雷达 / 分数 / 迷你图 */
const DIM_LABEL = { requirement_coverage: '完整性', accuracy: '准确性', technical_quality: '技术性', material_match: '匹配度', documentation: '规范性' };
export const dimLabel = (key) => DIM_LABEL[key] || key;

export function radar(dimensions, prev) {
  const entries = Object.values(dimensions || {});
  if (!entries.length) return emptyState('暂无评分维度');
  const size = 224;
  const c = size / 2;
  const r = c - 46;
  const n = entries.length;
  const point = (i, value) => {
    const angle = (Math.PI * 2 * i) / n - Math.PI / 2;
    const radius = (Math.max(0, Math.min(100, value)) / 100) * r;
    return [c + Math.cos(angle) * radius, c + Math.sin(angle) * radius];
  };
  const grid = [25, 50, 75, 100].map((level) => `<polygon class="radar-grid" points="${entries.map((_, i) => point(i, level).join(',')).join(' ')}"></polygon>`).join('');
  const axes = entries.map((_, i) => { const [x, y] = point(i, 100); return `<line class="radar-grid" x1="${c}" y1="${c}" x2="${x}" y2="${y}"></line>`; }).join('');
  const area = (dims) => entries.map((d, i) => point(i, dims[d.key]?.score ?? 0).join(',')).join(' ');
  const prevArea = prev ? `<polygon class="radar-area prev" points="${area(prev)}"></polygon>` : '';
  const labels = entries.map((d, i) => {
    const [x, y] = point(i, 112);
    const anchor = x < c - 8 ? 'end' : x > c + 8 ? 'start' : 'middle';
    return `<text class="radar-labels" x="${x}" y="${y}" text-anchor="${anchor}">${escapeHtml(dimLabel(d.key))} ${d.score}</text>`;
  }).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    ${grid}${axes}${prevArea}
    <polygon class="radar-area" points="${area(dimensions)}"></polygon>
    ${entries.map((d, i) => { const [x, y] = point(i, d.score); return `<circle cx="${x}" cy="${y}" r="2.4" fill="#1c4f9c"></circle>`; }).join('')}
    ${labels}
  </svg>`;
}

export function scoreRing(score, size = 112) {
  const n = Number(score ?? 0);
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const cls = scoreClass(n);
  return `<div class="score-ring ${cls}" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}">
      <circle class="sr-bg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"></circle>
      <circle class="sr-fg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"
        stroke-dasharray="${(c * Math.max(0, Math.min(100, n))) / 100} ${c}"></circle>
    </svg>
    <div class="sr-text"><strong>${n}</strong><span>${VERDICT_LABEL[cls === 'ok' ? 'pass' : cls === 'warn' ? 'revise' : 'regenerate']}</span></div>
  </div>`;
}

export function sparkline(values, { width = 180, height = 42 } = {}) {
  const list = (values || []).map(Number).filter((v) => Number.isFinite(v));
  if (list.length < 2) return `<div class="hint">数据不足</div>`;
  const min = Math.min(...list);
  const max = Math.max(...list);
  const span = Math.max(1, max - min);
  const pts = list.map((v, i) => [8 + (i * (width - 16)) / (list.length - 1), height - 8 - ((v - min) / span) * (height - 16)]);
  const path = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${path} L${pts.at(-1)[0]},${height - 4} L${pts[0][0]},${height - 4} Z`;
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <path d="${area}" fill="rgba(28,79,156,.10)"></path>
    <path d="${path}" fill="none" stroke="#1c4f9c" stroke-width="1.6"></path>
    ${pts.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2" fill="#1c4f9c"></circle>`).join('')}
  </svg>`;
}

export function barRow(label, value, max = 100, kind = '') {
  const pct = Math.max(0, Math.min(100, (Number(value) / max) * 100));
  return `<div class="bar-row"><span class="fs12 muted" style="width:92px">${escapeHtml(label)}</span>
    <div class="bar ${kind}"><i style="width:${pct}%"></i></div><span class="num">${value}</span></div>`;
}

/* ---------------------------------------------------------------- Diff */
export function diffView(diff) {
  const ops = diff?.ops || diff?.lines || [];
  if (!ops.length) return emptyState('两版内容一致', '没有检测到差异');
  const sign = { add: '+', del: '-', mod: '~', equal: ' ' };
  const rows = ops.slice(0, 600).map((op) => {
    const kind = op.type || op.kind || 'equal';
    if (kind === 'equal' && (op.text || op.value || '').length > 400) return '';
    const text = op.text ?? op.value ?? (op.before !== undefined ? `${op.before} → ${op.after}` : '');
    return `<tr class="${kind}"><td class="sign">${sign[kind] || ' '}</td><td>${escapeHtml(text)}</td></tr>`;
  }).join('');
  return `<table class="diff-table"><tbody>${rows}</tbody></table>`;
}

/* ---------------------------------------------------------------- 交互 */
export function toast(title, body = '', kind = 'ok', ttl = 4200) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const node = el('div', { class: `toast ${kind}` });
  node.innerHTML = `<div class="t-title">${escapeHtml(title)}</div>${body ? `<div class="t-body">${escapeHtml(body)}</div>` : ''}`;
  stack.appendChild(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transform = 'translateY(6px)';
    node.style.transition = 'all .2s';
    setTimeout(() => node.remove(), 220);
  }, ttl);
}

export function drawer(title, html, { width } = {}) {
  const box = document.getElementById('drawer');
  const mask = document.getElementById('drawer-mask');
  box.innerHTML = `<div class="drawer-head"><div class="card-title">${escapeHtml(title)}</div>
      <button class="icon-btn" data-drawer-close aria-label="关闭">✕</button></div>
    <div class="drawer-body">${html}</div>`;
  if (width) box.style.width = `min(${width}px, 94vw)`;
  box.hidden = false;
  mask.hidden = false;
  const close = () => { box.hidden = true; mask.hidden = true; box.innerHTML = ''; box.style.width = ''; };
  $('[data-drawer-close]', box).onclick = close;
  mask.onclick = close;
  document.addEventListener('keydown', function onKey(event) {
    if (event.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
  });
  return { close, body: $('.drawer-body', box) };
}

export function modal({ title, body, footer, wide = false, onMount }) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal-mask"><div class="modal ${wide ? 'wide' : ''}">
    <div class="modal-head"><div class="card-title">${escapeHtml(title)}</div>
      <button class="icon-btn right" data-modal-close aria-label="关闭">✕</button></div>
    <div class="modal-body">${body}</div>
    ${footer === null ? '' : `<div class="modal-foot">${footer || '<button class="btn" data-modal-close>关闭</button>'}</div>`}
  </div></div>`;
  const close = () => { root.innerHTML = ''; };
  $$('[data-modal-close]', root).forEach((b) => { b.onclick = close; });
  $('.modal-mask', root).addEventListener('click', (event) => { if (event.target.classList.contains('modal-mask')) close(); });
  onMount?.($('.modal', root), close);
  return { close, root: $('.modal', root) };
}

export function confirmDialog(question, { danger = false, okText = '确认' } = {}) {
  return new Promise((resolve) => {
    const { root, close } = modal({
      title: '请确认',
      body: `<p class="fs13">${escapeHtml(question)}</p>`,
      footer: `<button class="btn" data-cancel>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${escapeHtml(okText)}</button>`,
    });
    $('[data-cancel]', root).onclick = () => { close(); resolve(false); };
    $('[data-ok]', root).onclick = () => { close(); resolve(true); };
  });
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); }
  catch { toast('复制失败', '浏览器未授权剪贴板', 'bad'); }
}

export function downloadFile(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/* ---------------------------------------------------------------- 空态 / 加载 */
export function emptyState(text, hint = '', mark = '▦') {
  return `<div class="empty-state"><div class="e-mark">${mark}</div><div>${escapeHtml(text)}</div>${hint ? `<div class="fs11 mt4">${escapeHtml(hint)}</div>` : ''}</div>`;
}

export function loading(text = '加载中…') {
  return `<div class="loading-line"><span class="spinner"></span>${escapeHtml(text)}</div>`;
}

export function skeletonRows(n = 4) {
  return Array.from({ length: n }, (_, i) => `<div class="skeleton mb8" style="width:${92 - i * 7}%;height:14px"></div>`).join('');
}

/* ---------------------------------------------------------------- 其他 */
export function debounce(fn, wait = 280) {
  let timer;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
}

export function wordCount(text) {
  return String(text || '').replace(/\s+/g, '').length;
}

export function projectStatusPill(status) {
  return status === 'archived' ? pill('已归档', '') : pill('进行中', 'ok');
}

export function slaView(sla) {
  if (!sla) return '';
  const late = Number(sla.minutes_left) < 0;
  return `<span class="pill ${late ? 'bad' : Number(sla.minutes_left) < 60 ? 'warn' : 'plain'}">${late ? '已超时' : `剩 ${Math.max(0, Math.round(sla.minutes_left))} 分钟`}</span>`;
}
