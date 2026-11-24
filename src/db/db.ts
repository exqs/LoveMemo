// 数据库抽象：桌面端用 tauri-plugin-sql（SQLite 文件），浏览器预览用 sql.js（内存 + IndexedDB 持久化）
// 两边都使用 ? 占位符。tauri-plugin-sql 的多次 execute 可能落在不同连接上，所以不使用显式事务。
import { isTauri } from '../lib/platform'
import { MIGRATIONS } from './schema'

export type Bind = (string | number | null)[]
export interface Db {
  select<T = Record<string, unknown>>(sql: string, bind?: Bind): Promise<T[]>
  execute(sql: string, bind?: Bind): Promise<number>
}

let dbPromise: Promise<Db> | null = null
export function getDb(): Promise<Db> {
  if (!dbPromise) dbPromise = open().then(async (db) => { await migrate(db); return db })
  return dbPromise
}

async function open(): Promise<Db> {
  if (isTauri) {
    const { default: Database } = await import('@tauri-apps/plugin-sql')
    const d = await Database.load('sqlite:fupan.db')
    await d.execute('PRAGMA foreign_keys = ON')
    await d.execute('PRAGMA journal_mode = WAL')
    return {
      select: (sql, bind = []) => d.select(sql, bind),
      execute: async (sql, bind = []) => (await d.execute(sql, bind)).rowsAffected,
    }
  }
  return openSqlJs()
}

// ---------- 浏览器预览后端 ----------
const IDB_NAME = 'fupan-preview'
function idb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB_NAME, 1)
    r.onupgradeneeded = () => r.result.createObjectStore('kv')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
}
async function idbGet(): Promise<Uint8Array | undefined> {
  const d = await idb()
  return new Promise((res) => {
    const q = d.transaction('kv').objectStore('kv').get('db')
    q.onsuccess = () => res(q.result as Uint8Array | undefined)
    q.onerror = () => res(undefined)
  })
}
async function idbPut(v: Uint8Array) {
  const d = await idb()
  d.transaction('kv', 'readwrite').objectStore('kv').put(v, 'db')
}

async function openSqlJs(): Promise<Db> {
  const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
    import('sql.js'),
    import('sql.js/dist/sql-wasm.wasm?url'),
  ])
  const SQL = await initSqlJs({ locateFile: () => wasmUrl, useOldExtensionFunctions: true })
  // 界面预览（单文件 HTML）只用内存数据库，不读写 IndexedDB
  const memOnly = !!(window as unknown as { __FUPAN_PREVIEW__?: string }).__FUPAN_PREVIEW__
  const saved = memOnly ? undefined : await idbGet().catch(() => undefined)
  const db = saved ? new SQL.Database(saved) : new SQL.Database()
  db.run('PRAGMA foreign_keys = ON')
  let timer: ReturnType<typeof setTimeout> | undefined
  const persist = () => {
    if (memOnly) return
    clearTimeout(timer)
    timer = setTimeout(() => { idbPut(db.export()).catch(console.error) }, 400)
  }
  return {
    async select<T>(sql: string, bind: Bind = []) {
      const st = db.prepare(sql)
      st.bind(bind)
      const out: T[] = []
      while (st.step()) out.push(st.getAsObject() as T)
      st.free()
      return out
    },
    async execute(sql, bind = []) {
      db.run(sql, bind)
      persist()
      return db.getRowsModified()
    },
  }
}

/** 清空浏览器预览数据（仅开发用） */
export async function resetPreviewDb() {
  const d = await idb()
  d.transaction('kv', 'readwrite').objectStore('kv').delete('db')
}

async function migrate(db: Db) {
  await db.execute('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)')
  const r = await db.select<{ v: string }>("SELECT v FROM meta WHERE k='schema_version'")
  let ver = r.length ? Number(r[0].v) : 0
  for (const m of MIGRATIONS) {
    if (m.version <= ver) continue
    for (const stmt of m.sql.split(/;\s*\n/).map((s) => s.trim()).filter(Boolean)) {
      await db.execute(stmt)
    }
    ver = m.version
    await db.execute("INSERT OR REPLACE INTO meta (k, v) VALUES ('schema_version', ?)", [String(ver)])
  }
}
