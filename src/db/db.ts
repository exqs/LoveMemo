// 数据库：浏览器内 sql.js（SQLite）。登录后从服务器取回自己的数据库文件，改动后整份加密保存回服务器。
// 单文件界面预览（__FUPAN_PREVIEW__）只用内存数据库，不连服务器。
import { ApiError, dataGet, dataPut, isPreview } from '../lib/api'
import { MIGRATIONS } from './schema'

export type Bind = (string | number | null)[]
export interface Db {
  select<T = Record<string, unknown>>(sql: string, bind?: Bind): Promise<T[]>
  execute(sql: string, bind?: Bind): Promise<number>
}

let dbPromise: Promise<Db> | null = null
export function getDb(): Promise<Db> {
  if (!dbPromise) dbPromise = openSqlJs().then(async (db) => { await migrate(db); return db })
  return dbPromise
}

// ---------- 保存状态（界面上显示"保存中/保存失败/有冲突"） ----------
export type SaveState = 'saved' | 'pending' | 'saving' | 'error' | 'conflict' | 'expired'
let saveState: SaveState = 'saved'
const saveSubs = new Set<(s: SaveState) => void>()
function setSaveState(s: SaveState) { saveState = s; saveSubs.forEach((f) => f(s)) }
export function getSaveState() { return saveState }
export function onSaveState(f: (s: SaveState) => void) { saveSubs.add(f); return () => { saveSubs.delete(f) } }

interface Remote { owner: string; version: number; dirty: boolean; running: Promise<void> | null; timer?: ReturnType<typeof setTimeout>; exportFn: () => Uint8Array; conflictVersion?: number }
let remote: Remote | null = null

async function saveLoop() {
  const r = remote
  if (!r) return
  while (r.dirty) {
    r.dirty = false
    setSaveState('saving')
    try {
      r.version = await dataPut(r.exportFn(), r.version, r.owner)
    } catch (e) {
      r.dirty = true
      if (e instanceof ApiError && e.code === 'conflict') {
        r.conflictVersion = Number(e.extra.version ?? NaN)
        setSaveState('conflict')
      } else if (e instanceof ApiError && e.code === 'wrong_owner') {
        // 换了账号：这份数据不属于当前登录的人，停止保存
        setSaveState('conflict')
        r.conflictVersion = undefined
      } else if (e instanceof ApiError && e.status === 401) setSaveState('expired')
      else setSaveState('error')
      return
    }
  }
  setSaveState('saved')
}

function schedule() {
  const r = remote
  if (!r) return
  r.dirty = true
  if (saveState === 'conflict' || saveState === 'expired') return // 等用户处理
  if (saveState === 'saved') setSaveState('pending')
  clearTimeout(r.timer)
  r.timer = setTimeout(() => { void flushSave() }, 800)
}

/** 立即保存（排队：同一时间只有一个保存请求） */
export async function flushSave(): Promise<void> {
  const r = remote
  if (!r) return
  clearTimeout(r.timer)
  if (r.running) { await r.running; if (!r.dirty) return }
  r.running = saveLoop().finally(() => { r.running = null })
  await r.running
}
/** 重新登录后，或网络恢复后，重试保存 */
export function retrySave() {
  if (remote?.dirty) { setSaveState('pending'); void flushSave() }
}
/** 发生冲突时，用这台设备上的数据覆盖服务器上的 */
export async function overwriteServer() {
  const r = remote
  if (!r || !Number.isInteger(r.conflictVersion)) return
  r.version = r.conflictVersion!
  r.conflictVersion = undefined
  r.dirty = true
  setSaveState('pending')
  await flushSave()
}
export function hasUnsaved() { return !!remote && (remote.dirty || !!remote.running) }
/** 退出或换人登录前调用：之后不再往服务器保存任何东西，防止把上一个人的数据存进下一个人的账号 */
export function discardRemote() {
  if (remote) clearTimeout(remote.timer)
  remote = null
}

async function openSqlJs(): Promise<Db> {
  const [{ default: initSqlJs }, { default: wasmUrl }] = await Promise.all([
    import('sql.js'),
    import('sql.js/dist/sql-wasm.wasm?url'),
  ])
  const SQL = await initSqlJs({ locateFile: () => wasmUrl, useOldExtensionFunctions: true })
  let db: InstanceType<typeof SQL.Database>
  if (isPreview) {
    db = new SQL.Database()
  } else {
    const { version, owner, bytes } = await dataGet()
    db = bytes ? new SQL.Database(bytes) : new SQL.Database()
    remote = {
      owner, version, dirty: false, running: null,
      // export() 会重开数据库、把 PRAGMA 恢复默认，所以导出后要重新打开外键约束
      exportFn: () => { const out = db.export(); db.run('PRAGMA foreign_keys = ON'); return out },
    }
  }
  db.run('PRAGMA foreign_keys = ON')
  return {
    async select<T>(sql: string, bind: Bind = []) {
      const st = db.prepare(sql)
      try {
        st.bind(bind)
        const out: T[] = []
        while (st.step()) out.push(st.getAsObject() as T)
        return out
      } finally { st.free() }
    },
    async execute(sql, bind = []) {
      db.run(sql, bind)
      const n = db.getRowsModified()
      schedule()
      return n
    },
  }
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
