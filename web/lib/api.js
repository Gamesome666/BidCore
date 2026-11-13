// API 客户端：token + 项目上下文 + 统一错误处理 + SSE。
// 键名兼容旧版（bidflow.*）：演示/截图脚本可能用旧键注入会话。
const TOKEN_KEY = 'bidcore.token';
const LEGACY_TOKEN_KEY = 'bidflow.token';
const PROJECT_KEY = 'bidcore.projectId';
const LEGACY_PROJECT_KEY = 'bidflow.projectId';

export const store = {
  get token() { return localStorage.getItem(TOKEN_KEY) || localStorage.getItem(LEGACY_TOKEN_KEY) || ''; },
  set token(v) {
    if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  },
  get projectId() { return Number(localStorage.getItem(PROJECT_KEY) || localStorage.getItem(LEGACY_PROJECT_KEY) || 0); },
  set projectId(v) { localStorage.setItem(PROJECT_KEY, String(v)); },
  user: null,
  projects: [],
};

export class ApiError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

async function request(method, path, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (store.token) headers.Authorization = `Bearer ${store.token}`;
  if (store.projectId) headers['X-Project-Id'] = String(store.projectId);
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 204) return null;
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !opts.silent) {
      store.token = '';
      location.hash = '#/login';
    }
    throw new ApiError(res.status, data?.code, data?.error);
  }
  return data;
}

/**
 * multipart 上传：绝不能复用 request()。
 * 浏览器必须自己生成 Content-Type 里的 boundary，所以这里只带 Authorization，
 * 手动设置 'multipart/form-data' 会导致后端拿不到 boundary。
 */
async function uploadRequest(path, formData) {
  const headers = {};
  if (store.token) headers.Authorization = `Bearer ${store.token}`;
  if (store.projectId) headers['X-Project-Id'] = String(store.projectId);
  const res = await fetch(path, { method: 'POST', headers, body: formData });
  const type = res.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401) { store.token = ''; location.hash = '#/login'; }
    throw new ApiError(res.status, data?.code, data?.error);
  }
  return data;
}

const qs = (q) => (q && Object.keys(q).length ? `?${new URLSearchParams(q)}` : '');

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b ?? {}),
  put: (p, b) => request('PUT', p, b ?? {}),
  patch: (p, b) => request('PATCH', p, b ?? {}),
  del: (p) => request('DELETE', p),

  /* 会话 */
  login: (username, password) => request('POST', '/api/auth/login', { username, password }),
  me: () => request('GET', '/api/me'),

  /* 仪表盘 / 项目 */
  dashboard: () => request('GET', '/api/dashboard'),
  projects: () => request('GET', '/api/projects'),
  project: (id) => request('GET', `/api/projects/${id}`),
  createProject: (body) => request('POST', '/api/projects', body),
  updateProject: (id, body) => request('PUT', `/api/projects/${id}`, body),
  deleteProject: (id) => request('DELETE', `/api/projects/${id}`),
  deletionPreview: (id) => request('GET', `/api/projects/${id}/deletion-preview`),
  tender: (id) => request('GET', `/api/projects/${id}/tender`),
  /** 招标文件上传：multipart；autoParse=0 让前端接着跑 parse 步骤（有进度条） */
  uploadTender: (id, file) => {
    const form = new FormData();
    form.append('file', file);
    form.append('autoParse', '0');
    return uploadRequest(`/api/projects/${id}/tender/upload`, form);
  },
  /** 只解析不落库：新建项目弹窗「从文件导入」用 */
  parseTenderFile: (file) => {
    const form = new FormData();
    form.append('file', file);
    return uploadRequest('/api/tender/parse', form);
  },
  /** 粘贴招标正文（扫描件 OCR 后的兜底） */
  saveTenderText: (id, text, name) => request('POST', `/api/projects/${id}/tender/text`, { text, name, autoParse: 0 }),
  workspace: (id) => request('GET', `/api/projects/${id}/workspace`),

  /* 技术方案（对标 yibiao） */
  technicalPlan: (id) => request('GET', `/api/projects/${id}/technical-plan`),
  planStep: (id, step, options = {}) => request('POST', `/api/projects/${id}/technical-plan/steps`, { step, options }),
  saveOutline: (id, outline) => request('POST', `/api/projects/${id}/technical-plan/outline`, { outline }),
  saveChapter: (id, nodeId, markdown) => request('POST', `/api/projects/${id}/technical-plan/content`, { nodeId, markdown }),
  aiChapter: (id, nodeId, instruction = '') => request('POST', `/api/projects/${id}/technical-plan/content/ai`, { nodeId, instruction }),
  llmProbe: () => request('POST', '/api/llm/probe', {}),
  requirements: (id, veto = false) => request('GET', `/api/projects/${id}/requirements${veto ? '?veto=1' : ''}`),

  /* 响应偏离 / 检查 / 导出 */
  deviation: (id) => request('GET', `/api/projects/${id}/deviation`),
  generateDeviation: (id) => request('POST', `/api/projects/${id}/deviation/generate`, {}),
  patchDeviationRow: (id, rowId, body) => request('PATCH', `/api/projects/${id}/deviation/rows/${rowId}`, body),
  confirmDeviation: (id) => request('POST', `/api/projects/${id}/deviation/confirm`, {}),
  checks: (id) => request('GET', `/api/projects/${id}/checks`),
  runCheck: (id, kind) => request('POST', `/api/projects/${id}/checks/${kind}/run`, {}),
  exportProject: (id, body = {}) => request('POST', `/api/projects/${id}/export`, body),
  exports: (id) => request('GET', `/api/projects/${id}/exports`),

  /* 运行 */
  runs: (projectId) => request('GET', `/api/runs${projectId ? `?projectId=${projectId}` : ''}`),
  run: (id) => request('GET', `/api/runs/${id}`),
  startRun: (body) => request('POST', '/api/runs', body),
  command: (id, type, extra = {}) => request('POST', `/api/runs/${id}/commands`, { type, commandId: crypto.randomUUID(), ...extra }),
  skipNode: (id, nodeKey) => request('POST', `/api/runs/${id}/nodes/${encodeURIComponent(nodeKey)}/skip`, { commandId: crypto.randomUUID() }),
  events: (id, afterSeq = 0) => request('GET', `/api/runs/${id}/events?afterSeq=${afterSeq}`),
  artifacts: (id) => request('GET', `/api/runs/${id}/artifacts`),
  artifact: (id, kind, sub) => request('GET', `/api/runs/${id}/artifacts/${kind}${sub ? `?sub=${encodeURIComponent(sub)}` : ''}`),
  diff: (id, kind, from, to) => request('GET', `/api/runs/${id}/diff?kind=${encodeURIComponent(kind)}&from=${from}&to=${to}`),
  quality: (id) => request('GET', `/api/runs/${id}/quality`),
  supervisor: (id) => request('GET', `/api/runs/${id}/supervisor`),

  /* 审核 */
  reviews: (q = {}) => request('GET', `/api/reviews${qs(q)}`),
  reviewSummary: () => request('GET', '/api/reviews/summary'),
  review: (id) => request('GET', `/api/reviews/${id}`),
  decide: (id, body) => request('POST', `/api/reviews/${id}/decisions`, body),
  remind: (id) => request('POST', `/api/reviews/${id}/remind`, {}),
  reassign: (id, assigneeId) => request('POST', `/api/reviews/${id}/reassign`, { assigneeId }),
  reviewComments: (id) => request('GET', `/api/reviews/${id}/comments`),
  addReviewComment: (id, body) => request('POST', `/api/reviews/${id}/comments`, { body }),
  reviewHistory: (id) => request('GET', `/api/reviews/${id}/history`),

  /* 质量 */
  qualityReports: (runId) => request('GET', `/api/quality/reports${runId ? `?runId=${runId}` : ''}`),
  qualityConfig: () => request('GET', '/api/quality/config'),
  saveQualityConfig: (body) => request('PUT', '/api/quality/config', body),
  overrideQuality: (runId, reportId, comment = '') => request('POST', `/api/runs/${runId}/quality/${reportId}/override`, { comment }),

  /* 资产 / 团队 / 编排 */
  knowledge: (library) => request('GET', `/api/knowledge${library ? `?library=${library}` : ''}`),
  knowledgeOne: (id) => request('GET', `/api/knowledge/${id}`),
  saveKnowledge: (doc) => (doc.id ? request('PUT', `/api/knowledge/${doc.id}`, doc) : request('POST', '/api/knowledge', doc)),
  deleteKnowledge: (id) => request('DELETE', `/api/knowledge/${id}`),
  // 文件上传：FormData 必须走独立请求（见 uploadRequest 注释）
  uploadKnowledge: (formData) => uploadRequest('/api/knowledge/upload', formData),
  appendKnowledgeFiles: (id, formData) => uploadRequest(`/api/knowledge/${id}/files`, formData),
  reparseKnowledge: (id) => request('POST', `/api/knowledge/${id}/reparse`, {}),
  deleteKnowledgeFile: (id, fileId) => request('DELETE', `/api/knowledge/${id}/files/${encodeURIComponent(fileId)}`),
  // <img>/<iframe>/<a download> 不会带 Authorization，统一用 ?token=
  knowledgeFileUrl: (id, fileId, { download = false } = {}) =>
    `/api/knowledge/${encodeURIComponent(id)}/files/${encodeURIComponent(fileId)}?token=${encodeURIComponent(store.token)}${download ? '&download=1' : ''}`,
  agents: () => request('GET', '/api/agents'),
  saveAgent: (id, body) => request('PUT', `/api/agents/${id}`, body),
  workflowDefs: () => request('GET', '/api/workflow-defs'),
  saveWorkflowDef: (body) => request('POST', '/api/workflow-defs', body),

  /* 系统 */
  settings: () => request('GET', '/api/settings'),
  saveSettings: (body) => request('PUT', '/api/settings', body),
  llmStatus: () => request('GET', '/api/llm/status'),
  users: () => request('GET', '/api/users'),
  saveUser: (id, body) => (id ? request('PATCH', `/api/users/${id}`, body) : request('POST', '/api/users', body)),

  /* 兼容层 */
  taskActive: () => request('GET', '/api/tasks/active'),
  startTask: (type, body = {}) => request('POST', `/api/tasks/start-${type}`, body),
  exportDocx: (projectId) => request('POST', '/api/export/docx', { projectId }),
};

/* SSE：自动重连 + 状态回调 */
export function connectEvents(projectId, handlers = {}) {
  let closed = false;
  let source = null;
  let retry = 0;
  const base = `/api/events?projectId=${projectId || 0}`;

  function open() {
    if (closed) return;
    source = new EventSource(`${base}&token=${encodeURIComponent(store.token)}`);
    source.addEventListener('open', () => { retry = 0; handlers.onStatus?.(true); });
    source.addEventListener('error', () => {
      handlers.onStatus?.(false);
      source?.close();
      if (!closed) setTimeout(open, Math.min(15000, 1000 * 2 ** retry++));
    });
    for (const channel of ['workflow', 'review', 'quality', 'tasks']) {
      source.addEventListener(channel, (event) => {
        try { handlers.onMessage?.(channel, JSON.parse(event.data)); } catch { /* ignore */ }
      });
    }
  }
  open();
  return () => { closed = true; source?.close(); handlers.onStatus?.(false); };
}
