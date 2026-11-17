#!/usr/bin/env node
// 一键导入知识库演示数据包：tools/knowledge-pack.json
//
// 用法（先启动 BidCore，默认 http://127.0.0.1:5192）：
//   node tools/import-knowledge.mjs
//   node tools/import-knowledge.mjs --base http://127.0.0.1:5192 --user admin --pass admin123
//
// 说明：只新增库中不存在的同名文档，已存在的跳过；不会覆盖你手动改过的文档。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const pick = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const BASE = pick('base', 'http://127.0.0.1:5192');
const USER = pick('user', 'admin');
const PASS = pick('pass', 'admin123');
const PACK = pick('pack', join(here, 'knowledge-pack.json'));

const pack = JSON.parse(readFileSync(PACK, 'utf8'));
console.log(`数据包：${pack.count} 篇（${PACK}）`);

const login = await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
})).json();
if (!login.token) {
  console.error('登录失败，请检查 --base / --user / --pass');
  process.exit(1);
}
const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${login.token}` };

const existing = await (await fetch(`${BASE}/api/knowledge`, { headers: H })).json();
const list = Array.isArray(existing) ? existing : existing.items || [];
const titles = new Set(list.map((d) => String(d.title || '').trim()));
console.log(`当前库内已有 ${list.length} 篇`);

let added = 0;
let skipped = 0;
let failed = 0;
for (const doc of pack.docs) {
  const title = String(doc.title || '').trim();
  if (!title) continue;
  if (titles.has(title)) {
    skipped++;
    continue;
  }
  const res = await fetch(`${BASE}/api/knowledge`, { method: 'POST', headers: H, body: JSON.stringify(doc) });
  if (res.status === 201) {
    added++;
    titles.add(title);
    console.log(`  + ${title}`);
  } else {
    failed++;
    console.log(`  ! ${title} → HTTP ${res.status} ${(await res.text()).slice(0, 80)}`);
  }
}

console.log(`\n完成：新增 ${added} 篇，跳过 ${skipped} 篇，失败 ${failed} 篇`);
console.log('刷新页面「企业知识库」即可看到；再跑一次投标流程，资质分（MAT-01）会明显提升。');
