// 零依赖 .env 加载器：进程启动时把仓库根目录 .env 注入 process.env（不覆盖已有变量）。
// 目的：`node server/index.mjs` 即可带真实模型配置运行，无需 --env-file 或 dotenv 依赖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../..');

function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function loadEnv(file = path.join(ROOT, '.env')) {
  try {
    if (!fs.existsSync(file)) return { loaded: false, keys: [] };
    const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
    const keys = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (process.env[key] === undefined) { process.env[key] = value; keys.push(key); }
    }
    return { loaded: true, keys };
  } catch {
    return { loaded: false, keys: [] };
  }
}

// 引入即生效（副作用 import，放在 server/index.mjs 顶部）
export const envInfo = loadEnv();
