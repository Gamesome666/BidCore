// 重置数据库并重新灌入演示数据（默认删除 var/bidcore.db*；BIDCORE_DB 可指向测试库）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAR = path.resolve(__dirname, '..', 'var');
const ROOT = path.resolve(__dirname, '..');
const configured = process.env.BIDCORE_DB ? path.resolve(ROOT, process.env.BIDCORE_DB) : path.join(VAR, 'bidcore.db');
for (const target of [configured, `${configured}-wal`, `${configured}-shm`]) {
  if (fs.existsSync(target)) fs.rmSync(target);
}
const { seed } = await import('./seed.mjs');
const result = seed();
console.log('[reset] 数据库已重置', result);
