// 服务端数据库（账号、会话、注册码、审计）。用 Node 内置 node:sqlite，全部是参数化查询。
// 用户自己的便签数据不在这里，而是加密后单独存文件（见 userdata.ts），服务端从不解析其中的 SQL。
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type DB = DatabaseSync

const MIGRATIONS: string[] = [
  `
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  username_norm TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('superadmin', 'user')),
  password_hash TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  password_changed_at INTEGER NOT NULL,
  data_version INTEGER NOT NULL DEFAULT 0,
  data_size INTEGER NOT NULL DEFAULT 0,
  invite_id TEXT
);
CREATE UNIQUE INDEX users_one_superadmin ON users(role) WHERE role = 'superadmin';
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('web', 'desktop')),
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  ua TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE TABLE invite_uses (
  invite_id TEXT NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE TABLE login_throttle (
  key TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  locked_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  user_id TEXT,
  username TEXT NOT NULL DEFAULT '',
  event TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX audit_at ON audit(at);
CREATE TABLE llm_usage (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  tin INTEGER NOT NULL DEFAULT 0,
  tout INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
`,
  // v2：AI 服务商和模型由超级管理员在管理页配置。API Key 加密存放（key_enc），任何接口都不返回明文
  `
CREATE TABLE llm_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('openai', 'anthropic')),
  base_url TEXT NOT NULL,
  key_enc BLOB,
  key_hint TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE llm_models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  supports_vision INTEGER NOT NULL DEFAULT 0,
  supports_json INTEGER NOT NULL DEFAULT 1,
  max_tokens INTEGER NOT NULL,
  timeout_s INTEGER NOT NULL DEFAULT 120,
  temperature REAL,
  quirks TEXT NOT NULL DEFAULT '{}',
  price_in REAL,
  price_out REAL,
  routes TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE (provider_id, model)
);
`,
]

export function openDb(dataDir: string): DB {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(join(dataDir, 'server.sqlite'))
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON')
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)')
  const row = db.prepare("SELECT v FROM meta WHERE k = 'schema'").get() as { v: string } | undefined
  let ver = row ? Number(row.v) : 0
  for (let i = ver; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i])
      db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema', ?)").run(String(i + 1))
    })
    ver = i + 1
  }
  return db
}

/** 同步事务。Node 单线程 + 同步执行，事务内不会被其他请求插队 */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = fn()
    db.exec('COMMIT')
    return r
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

export interface UserRow {
  id: string
  username: string
  username_norm: string
  role: 'superadmin' | 'user'
  password_hash: string
  disabled: number
  created_at: number
  last_login_at: number | null
  password_changed_at: number
  data_version: number
  data_size: number
  invite_id: string | null
}

export function audit(db: DB, event: string, p: { userId?: string | null; username?: string; ip?: string; detail?: string } = {}) {
  db.prepare('INSERT INTO audit (at, user_id, username, event, ip, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .run(Date.now(), p.userId ?? null, (p.username ?? '').slice(0, 64), event, (p.ip ?? '').slice(0, 64), (p.detail ?? '').slice(0, 300))
}

/** 定期清理：过期会话、旧的登录失败记录、90 天前的审计日志 */
export function housekeeping(db: DB, idleMs: number) {
  const now = Date.now()
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR last_seen < ?').run(now, now - idleMs)
  db.prepare('DELETE FROM login_throttle WHERE updated_at < ? AND locked_until < ?').run(now - 2 * 86400_000, now)
  db.prepare('DELETE FROM audit WHERE at < ?').run(now - 90 * 86400_000)
  db.prepare("DELETE FROM llm_usage WHERE day < date('now', '-400 days')").run()
}
