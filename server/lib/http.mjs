// 极简 HTTP 工具：路由匹配 / JSON 响应 / 请求体解析。零依赖。
export function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

export function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve({ raw }); }
    });
    req.on('error', reject);
  });
}

export function createRouter() {
  const routes = [];
  function add(method, pattern, handler, opts = {}) {
    routes.push({ method, pattern, handler, opts, segments: pattern.split('/').filter(Boolean) });
  }
  function match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    for (const route of routes) {
      if (route.method !== method) continue;
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i += 1) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) { ok = false; break; }
      }
      if (ok) return { route, params };
    }
    return null;
  }
  return { add, match, routes };
}

export function parseUrl(url) {
  const u = new URL(url, 'http://localhost');
  return { pathname: u.pathname.replace(/\/+$/, '') || '/', query: Object.fromEntries(u.searchParams.entries()) };
}

export function sendError(res, status, code, message) {
  sendJson(res, status, { error: message || code, code });
}
