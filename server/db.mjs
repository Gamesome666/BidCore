// 数据层：node:sqlite（Node 24 内置，零依赖）。
// 设计文档用的是 Prisma + PostgreSQL；本项目改用 node:sqlite 的取舍见 README §5「架构」：
//  · 单文件数据库、无需 DB 服务，任何机器上 `node server/index.mjs` 就能跑；
//  · 表结构与设计稿的工作流表 + 审核/质量表一一对应，字段名保持 snake_case；
//  · 迁移到 PostgreSQL 时只需把 SQL 类型 TEXT→JSONB/TIMESTAMPTZ，DAO 层不用改。
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const VAR_DIR = path.join(ROOT, 'var');
export const DB_PATH = process.env.BIDCORE_DB || path.join(VAR_DIR, 'bidcore.db');

fs.mkdirSync(VAR_DIR, { recursive: true });
fs.mkdirSync(path.join(VAR_DIR, 'files'), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'user',
  modules       TEXT NOT NULL DEFAULT '[]',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  bidder_name TEXT,
  description TEXT DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'active',
  owner_id    INTEGER NOT NULL,
  tender_text TEXT DEFAULT '',
  tender_name TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_docs (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  folder     TEXT DEFAULT '未分类',
  category   TEXT DEFAULT 'case',
  content    TEXT NOT NULL,
  tags       TEXT DEFAULT '',
  expires_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kdocs_cat ON knowledge_docs(category);

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL,
  description   TEXT DEFAULT '',
  model_tier    TEXT DEFAULT 'standard',
  tools         TEXT DEFAULT '[]',
  system_prompt TEXT DEFAULT '',
  enabled       INTEGER NOT NULL DEFAULT 1,
  sort          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workflow_defs (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  name        TEXT NOT NULL,
  description TEXT DEFAULT '',
  graph_json  TEXT NOT NULL,
  policy_json TEXT NOT NULL DEFAULT '{}',
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  UNIQUE(key, version)
);

CREATE TABLE IF NOT EXISTS runs (
  id             TEXT PRIMARY KEY,
  project_id     INTEGER NOT NULL,
  def_key        TEXT NOT NULL DEFAULT 'default',
  def_version    INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'planning',
  objective      TEXT NOT NULL,
  plan_json      TEXT,
  plan_version   INTEGER NOT NULL DEFAULT 0,
  context_json   TEXT NOT NULL DEFAULT '{}',
  budget_json    TEXT NOT NULL DEFAULT '{}',
  parallelism    INTEGER NOT NULL DEFAULT 2,
  dry_run        INTEGER NOT NULL DEFAULT 0,
  mode           TEXT NOT NULL DEFAULT 'auto',
  created_by     INTEGER NOT NULL,
  started_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  finished_at    TEXT,
  error_code     TEXT,
  error_message  TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, updated_at);

CREATE TABLE IF NOT EXISTS node_runs (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_key        TEXT NOT NULL,
  agent_key       TEXT NOT NULL,
  node_type       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  attempt         INTEGER NOT NULL DEFAULT 0,
  iteration       INTEGER NOT NULL DEFAULT 0,
  depends_on      TEXT NOT NULL DEFAULT '[]',
  input_json      TEXT NOT NULL DEFAULT '{}',
  output_json     TEXT,
  artifact_kind   TEXT,
  artifact_version INTEGER,
  lease_owner     TEXT,
  lease_expires_at TEXT,
  dedupe_key      TEXT NOT NULL,
  quality_score   INTEGER,
  error_code      TEXT,
  error_message   TEXT,
  started_at      TEXT,
  finished_at     TEXT,
  updated_at      TEXT NOT NULL,
  UNIQUE(run_id, node_key, attempt)
);
CREATE INDEX IF NOT EXISTS idx_nodes_run ON node_runs(run_id, status);
CREATE INDEX IF NOT EXISTS idx_nodes_lease ON node_runs(status, lease_expires_at);

CREATE TABLE IF NOT EXISTS artifacts (
  id              TEXT PRIMARY KEY,
  run_id          TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_run_id     TEXT,
  kind            TEXT NOT NULL,
  version         INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  sha256          TEXT NOT NULL,
  summary         TEXT NOT NULL,
  payload_json    TEXT,
  storage_path    TEXT,
  provenance_json TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  UNIQUE(run_id, kind, version)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind ON artifacts(run_id, kind, version DESC);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  actor_type   TEXT NOT NULL DEFAULT 'system',
  actor_id     INTEGER,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL,
  UNIQUE(run_id, seq)
);

CREATE TABLE IF NOT EXISTS commands (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  command_id   TEXT NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'applied',
  result_json  TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE(run_id, command_id)
);

CREATE TABLE IF NOT EXISTS review_policies (
  id           TEXT PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  levels_json  TEXT NOT NULL,
  timeout_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review_tasks (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_run_id      TEXT NOT NULL,
  gate_key         TEXT NOT NULL,
  level            INTEGER NOT NULL DEFAULT 1,
  level_total      INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'pending',
  assignee_id      INTEGER,
  assignee_role    TEXT NOT NULL DEFAULT 'project-owner',
  project_id       INTEGER NOT NULL,
  artifact_kind    TEXT NOT NULL,
  artifact_version INTEGER NOT NULL DEFAULT 1,
  priority         INTEGER NOT NULL DEFAULT 0,
  remind_at        TEXT NOT NULL,
  sla_due_at       TEXT NOT NULL,
  reminded_at      TEXT,
  escalated_to     INTEGER,
  version          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  closed_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_status ON review_tasks(status, sla_due_at);
CREATE INDEX IF NOT EXISTS idx_reviews_assignee ON review_tasks(assignee_id, status);
CREATE INDEX IF NOT EXISTS idx_reviews_run ON review_tasks(run_id, gate_key, level);

CREATE TABLE IF NOT EXISTS review_decisions (
  id             TEXT PRIMARY KEY,
  review_task_id TEXT NOT NULL UNIQUE REFERENCES review_tasks(id) ON DELETE CASCADE,
  run_id         TEXT NOT NULL,
  gate_key       TEXT NOT NULL,
  level          INTEGER NOT NULL,
  action         TEXT NOT NULL,
  reviewer_id    INTEGER NOT NULL,
  comment        TEXT NOT NULL,
  targets_json   TEXT NOT NULL DEFAULT '[]',
  edits_json     TEXT NOT NULL DEFAULT '[]',
  evidence_json  TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quality_reports (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  node_run_id   TEXT,
  node_key      TEXT NOT NULL,
  iteration     INTEGER NOT NULL DEFAULT 1,
  total_score   INTEGER NOT NULL,
  dimension_json TEXT NOT NULL,
  verdict       TEXT NOT NULL,
  findings_json TEXT NOT NULL DEFAULT '[]',
  judge_json    TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quality_run ON quality_reports(run_id, created_at);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 兼容原仓库的任务引擎表面：/api/tasks/start-* 等接口写这张表
CREATE TABLE IF NOT EXISTS tasks (
  id           TEXT PRIMARY KEY,
  project_id   INTEGER NOT NULL,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'running',
  progress     INTEGER NOT NULL DEFAULT 0,
  logs_json    TEXT NOT NULL DEFAULT '[]',
  payload_json TEXT NOT NULL DEFAULT '{}',
  stats_json   TEXT,
  error        TEXT,
  started_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, started_at DESC);

-- 技术方案工作区（对齐原仓库 technical_plan_* 的"单项目一行 JSON"形态）
CREATE TABLE IF NOT EXISTS project_state (
  project_id INTEGER PRIMARY KEY,
  data_json  TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

-- 审核评论线程（与不可变的 review_decisions 分开：决策是裁决，评论是沟通）
CREATE TABLE IF NOT EXISTS review_comments (
  id             TEXT PRIMARY KEY,
  review_task_id TEXT NOT NULL,
  run_id         TEXT NOT NULL,
  author_id      INTEGER NOT NULL,
  body           TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'comment',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_comments ON review_comments(review_task_id, created_at);

-- 导出记录（Word 产物 + 导出前置校验快照）
CREATE TABLE IF NOT EXISTS exports (
  id              TEXT PRIMARY KEY,
  project_id      INTEGER NOT NULL,
  run_id          TEXT,
  file_name       TEXT NOT NULL,
  path            TEXT NOT NULL,
  bytes           INTEGER NOT NULL,
  sha256          TEXT NOT NULL,
  validation_json TEXT NOT NULL DEFAULT '{}',
  created_by      INTEGER,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exports_project ON exports(project_id, created_at DESC);
`;

db.exec(SCHEMA);

/**
 * 轻量迁移：sqlite 没有 ADD COLUMN IF NOT EXISTS，这里用 PRAGMA 判存后再 ALTER。
 * 目的：老库（bidflow 迁移过来的 var/bidcore.db）与全新库都能直接启动，无需手工迁移脚本。
 */
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

ensureColumn('users', 'title', "TEXT DEFAULT ''");
ensureColumn('users', 'department', "TEXT DEFAULT ''");
ensureColumn('projects', 'deadline', 'TEXT');
ensureColumn('projects', 'budget', 'TEXT');
ensureColumn('projects', 'industry', "TEXT DEFAULT ''");
ensureColumn('projects', 'tender_meta_json', "TEXT DEFAULT '{}'");
ensureColumn('knowledge_docs', 'library', "TEXT DEFAULT 'doc'");
ensureColumn('knowledge_docs', 'file_name', "TEXT DEFAULT ''");
ensureColumn('knowledge_docs', 'meta_json', "TEXT DEFAULT '{}'");
ensureColumn('review_tasks', 'policy_key', "TEXT DEFAULT 'default'");
ensureColumn('review_tasks', 'comment_count', 'INTEGER DEFAULT 0');
ensureColumn('review_tasks', 'escalated_from', 'INTEGER');

// 回填：老数据没有 library 时按 category 推断四库归属
db.exec(`UPDATE knowledge_docs SET library = CASE
  WHEN category IN ('company','qualification') THEN 'company'
  WHEN category IN ('personnel','person') THEN 'personnel'
  WHEN category IN ('tool','asset') THEN 'tool'
  ELSE 'doc' END
WHERE library IS NULL OR library = '' OR library = 'doc'`);

/** 参数归一：undefined → null（node:sqlite 不接受 undefined） */
function norm(params) {
  return params.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return v;
  });
}

export function all(sql, ...params) {
  return db.prepare(sql).all(...norm(params));
}
export function get(sql, ...params) {
  return db.prepare(sql).get(...norm(params)) ?? null;
}
export function run(sql, ...params) {
  return db.prepare(sql).run(...norm(params));
}
export function exec(sql) {
  return db.exec(sql);
}

let txDepth = 0;
/** 同步事务（node:sqlite 是同步 API，事务内不能 await） */
export function tx(fn) {
  const outer = txDepth > 0;
  if (!outer) db.exec('BEGIN IMMEDIATE');
  txDepth += 1;
  try {
    const result = fn();
    txDepth -= 1;
    if (!outer) db.exec('COMMIT');
    return result;
  } catch (error) {
    txDepth -= 1;
    if (!outer) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
    }
    throw error;
  }
}

export function jparse(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function jstr(value) {
  return JSON.stringify(value ?? null);
}
