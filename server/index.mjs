// BidCore 服务入口：REST + SSE + 静态资源 + 后台循环（SLA / 调度 / 恢复）。零依赖。
// 注意：env 必须是第一个 import（副作用加载 .env），否则 db.mjs 会先读默认路径。
import { envInfo } from './lib/env.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed, ensureCatalog } from './seed.mjs';
import { router, startBackgroundLoops } from './api.mjs';
import { engine } from './domain/engine.mjs';
import { parseUrl, sendJson, sendError } from './lib/http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB_ROOT = path.join(ROOT, 'web');
const PORT = Number(process.env.PORT || 5192);
const HOST = process.env.HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const boot = seed();
const catalog = ensureCatalog();

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(WEB_ROOT, rel);
  if (!target.startsWith(WEB_ROOT)) return sendError(res, 403, 'FORBIDDEN', '非法路径');
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    // SPA 回退：非静态资源一律回 index.html（hash 路由）
    const fallback = path.join(WEB_ROOT, 'index.html');
    if (!fs.existsSync(fallback)) return sendError(res, 404, 'NOT_FOUND', '前端未构建');
    const html = fs.readFileSync(fallback);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': html.length });
    return res.end(html);
  }
  const ext = path.extname(target).toLowerCase();
  const body = fs.readFileSync(target);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=60',
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const { pathname, query } = parseUrl(req.url || '/');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Project-Id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  try {
    const hit = router.match(req.method, pathname);
    if (hit) {
      await hit.route.handler({ req, res, params: hit.params, query, pathname });
      if (process.env.BIDCORE_LOG !== '0') {
        console.log(`[api] ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
      return;
    }
    if (pathname.startsWith('/api/')) return sendError(res, 404, 'NOT_FOUND', `接口不存在：${req.method} ${pathname}`);
    return serveStatic(req, res, pathname);
  } catch (error) {
    if (!res.headersSent) sendError(res, 500, 'INTERNAL_ERROR', String(error?.message || error));
    else try { res.end(); } catch { /* ignore */ }
    console.error('[error]', error);
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log('');
  console.log('  BidCore · 标序 — 可人工干预的 Multi-Agent 投标平台');
  console.log(`  ────────────────────────────────────────`);
  console.log(`  Web     ${url}`);
  console.log(`  API     ${url}/api/health`);
  console.log(`  DB      ${process.env.BIDCORE_DB || path.join(ROOT, 'var', 'bidcore.db')}`);
  console.log(`  模型    ${process.env.LLM_MODE === 'openai' ? `${process.env.LLM_MODEL || 'deepseek-v4.1-flash'} @ opencode 网关` : '确定性 Mock（离线可用）'}`);
  console.log(`  账号    admin/admin123 · owner/owner123 · tech/tech123 · biz/biz123 · reviewer/reviewer123`);
  console.log(`  种子    ${boot.seeded ? '已初始化演示数据' : '复用现有数据（npm run reset 可重置）'}`);
  if (catalog.agentsAdded?.length || catalog.workflowUpgraded) {
    console.log(`  升级    Agent +${catalog.agentsAdded?.length || 0}（${catalog.agentsAdded?.join(',') || '无'}）${catalog.workflowUpgraded ? ' / 工作流已升级为十步流水线' : ''}`);
  }
  console.log('');
});

startBackgroundLoops();
setTimeout(() => {
  try { engine.reconcileAll(); } catch (error) { console.error('[recover]', error); }
}, 3000);

process.on('SIGINT', () => { console.log('\nbye'); process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });
