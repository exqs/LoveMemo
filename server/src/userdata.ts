// 每个用户的便签数据库：前端整份导出的 SQLite 文件，服务端加密后落盘，只存取字节，从不打开或执行。
// 版本号做乐观锁：两个标签页/设备同时改，后保存的会收到冲突提示，不会悄悄覆盖。
import { mkdir, open, readFile, readdir, rename, rm, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { DB } from './db.ts'
import { decrypt, deriveDataKey, encrypt } from './crypto.ts'
import { HttpError } from './http.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1')
const KEEP = 3 // 每人保留最近 3 个版本，误操作时管理员可以在服务器上手动回滚

export class UserData {
  private root: string
  private key: Buffer
  private db: DB
  private locks = new Map<string, Promise<unknown>>()

  constructor(dataDir: string, masterKey: Buffer, db: DB) {
    this.root = join(dataDir, 'userdata')
    this.key = deriveDataKey(masterKey)
    this.db = db
  }

  private dir(userId: string): string {
    // 路径只由服务端生成的 UUID 组成，不含任何用户输入
    if (!UUID.test(userId)) throw new Error('bad user id')
    return join(this.root, userId)
  }

  /** 同一用户的读写排队执行 */
  private serial<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(userId) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    this.locks.set(userId, next)
    next.finally(() => { if (this.locks.get(userId) === next) this.locks.delete(userId) }).catch(() => {})
    return next
  }

  private version(userId: string): number {
    const r = this.db.prepare('SELECT data_version FROM users WHERE id = ?').get(userId) as { data_version: number } | undefined
    if (!r) throw new HttpError(404, 'not_found', '账号不存在')
    return r.data_version
  }

  read(userId: string): Promise<{ version: number; bytes: Buffer | null }> {
    return this.serial(userId, async () => {
      const v = this.version(userId)
      if (v === 0) return { version: 0, bytes: null }
      const blob = await readFile(join(this.dir(userId), `${v}.bin`))
      return { version: v, bytes: decrypt(this.key, blob, `${userId}:${v}`) }
    })
  }

  write(userId: string, baseVersion: number, bytes: Buffer): Promise<number> {
    if (bytes.length < 512 || !bytes.subarray(0, 16).equals(SQLITE_MAGIC)) {
      return Promise.reject(new HttpError(400, 'bad_data', '数据格式不对'))
    }
    return this.serial(userId, async () => {
      const cur = this.version(userId)
      if (cur !== baseVersion) throw new HttpError(409, 'conflict', '数据在别的页面或设备上改过了，请刷新后再操作', { version: cur })
      const next = cur + 1
      const dir = this.dir(userId)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      const final = join(dir, `${next}.bin`)
      const tmp = `${final}.tmp`
      const fh = await open(tmp, 'w', 0o600)
      try {
        await fh.writeFile(encrypt(this.key, bytes, `${userId}:${next}`))
        await fh.sync()
      } finally { await fh.close() }
      await rename(tmp, final)
      const changed = this.db.prepare('UPDATE users SET data_version = ?, data_size = ? WHERE id = ? AND data_version = ?').run(next, bytes.length, userId, cur).changes
      if (!changed) { await unlink(final).catch(() => {}); throw new HttpError(409, 'conflict', '数据在别的页面或设备上改过了，请刷新后再操作') }
      await this.prune(dir, next)
      return next
    })
  }

  private async prune(dir: string, latest: number) {
    for (const f of await readdir(dir)) {
      const m = /^(\d+)\.bin(\.tmp)?$/.exec(f)
      if (!m) continue
      if (m[2] || Number(m[1]) <= latest - KEEP) await unlink(join(dir, f)).catch(() => {})
    }
  }

  remove(userId: string): Promise<void> {
    return this.serial(userId, async () => { await rm(this.dir(userId), { recursive: true, force: true }) })
  }
}
