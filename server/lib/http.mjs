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

/**
 * 读取原始请求体（multipart 上传用）。与 readBody 的区别：
 *  · 返回 Buffer，不做 JSON 解析（文件二进制不能当字符串处理）；
 *  · 超限时立刻停止收集并抛 code=FILE_TOO_LARGE，由路由回 413 后再销毁连接。
 */
export function readRawBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    function cleanup() {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
    }
    function finish(fn, value) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    }
    function onData(chunk) {
      size += chunk.length;
      if (size > limit) {
        const error = new Error(`请求体超过 ${Math.round(limit / 1024 / 1024)}MB 上限`);
        error.code = 'FILE_TOO_LARGE';
        // 先暂停读取，路由写完 413 再 destroy；直接 destroy 会把响应一并掐断
        finish(reject, error);
        req.pause();
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() { finish(resolve, Buffer.concat(chunks)); }
    function onError(error) { finish(reject, error); }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
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
