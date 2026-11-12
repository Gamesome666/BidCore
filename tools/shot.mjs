// 零依赖截图工具：用 Edge/Chrome 的 CDP 抓页面（用于自检 UI）
// 用法：node tools/shot.mjs <url> <out.png> [--token=xxx] [--project=1] [--wait=2500] [--width=1440] [--height=980]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const url = args[0];
const out = args[1];
const opt = Object.fromEntries(args.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const width = Number(opt.width || 1440);
const height = Number(opt.height || 980);
const wait = Number(opt.wait || 2600);

const CANDIDATES = [
  process.env.BROWSER_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const browser = CANDIDATES.find((p) => fs.existsSync(p));
if (!browser) { console.error('未找到 Chrome/Edge'); process.exit(2); }

const port = 9300 + Math.floor(Math.random() * 400);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bidcore-shot-'));
const child = spawn(browser, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars', '--mute-audio',
  `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--window-size=${width},${height}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* retry */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
}

try {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  const cdp = new Cdp(ws);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const origin = new URL(url).origin;
  await cdp.send('Page.navigate', { url: `${origin}/#/login` });
  await sleep(900);
  if (opt.token) {
    // 关键：在每次新文档创建前写入 localStorage，避免 hash 导航不重跑 boot() 时仍停留在登录页
    const seed = `localStorage.setItem('bidcore.token', ${JSON.stringify(opt.token)}); localStorage.setItem('bidcore.projectId', ${JSON.stringify(String(opt.project || 1))});`;
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: seed });
    await cdp.send('Runtime.evaluate', { expression: seed });
  } else if (opt.clear === '1') {
    await cdp.send('Runtime.evaluate', { expression: "localStorage.clear()" });
  }
  await cdp.send('Page.navigate', { url });
  // 同文档 hash 导航不会重新执行 boot()：用带时间戳的查询串强制整页加载
  const [base, hash = ''] = url.split('#');
  const bust = `${base}${base.includes('?') ? '&' : '?'}shot=${Date.now()}${hash ? `#${hash}` : ''}`;
  await cdp.send('Page.navigate', { url: bust });
  await sleep(wait);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(`[shot] ${out} ${fs.statSync(out).size} bytes`);
  ws.close();
} catch (error) {
  console.error('[shot] failed:', error.message);
  process.exitCode = 1;
} finally {
  child.kill();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ } process.exit(); }, 300);
}


