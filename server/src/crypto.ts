// 密码哈希、随机令牌、数据加密。只用 Node 内置 crypto，不引入第三方库。
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

// ---------- 随机令牌 ----------
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
export function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex')
}
/** 定长比较两个十六进制摘要，避免按字节提前返回造成的时间差 */
export function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex')
  const y = Buffer.from(b, 'hex')
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

// Crockford Base32：去掉 I L O U，人工抄写不容易混淆
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** 生成人可读的一次性码，例如 7K3QD-9XWZP-…（每组 5 位，每位 5 bit） */
export function humanCode(groups: number): string {
  const n = groups * 5
  const bytes = randomBytes(n)
  let s = ''
  // 256 % 32 == 0，直接取低 5 位没有偏差
  for (let i = 0; i < n; i++) s += B32[bytes[i] & 31]
  return s.match(/.{5}/g)!.join('-')
}
/** 用户输入的码：转大写、去掉空格和横线、把易混字符换回来 */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
}

// ---------- 密码哈希（scrypt） ----------
const KEYLEN = 64
function scryptAsync(pw: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((res, rej) => {
    scrypt(pw.normalize('NFKC'), salt, KEYLEN, { N, r, p, maxmem: 256 * N * r + 32 * 1024 * 1024 }, (err, key) => (err ? rej(err) : res(key)))
  })
}

// 同时进行的哈希计算数量有上限：防止有人并发刷登录把内存和 CPU 打满
const MAX_PARALLEL = 2
const MAX_QUEUE = 64
let running = 0
const queue: (() => void)[] = []
export class BusyError extends Error {}
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) {
    if (queue.length >= MAX_QUEUE) throw new BusyError('busy')
    await new Promise<void>((r) => queue.push(r))
  }
  running++
  try { return await fn() } finally {
    running--
    queue.shift()?.()
  }
}

export async function hashPassword(pw: string, logN: number): Promise<string> {
  const salt = randomBytes(16)
  const N = 2 ** logN, r = 8, p = 1
  const key = await limited(() => scryptAsync(pw, salt, N, r, p))
  return `scrypt$${logN}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const logN = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3])
  if (!(logN >= 14 && logN <= 20 && r === 8 && p === 1)) return false
  const salt = Buffer.from(parts[4], 'base64')
  const expect = Buffer.from(parts[5], 'base64')
  const key = await limited(() => scryptAsync(pw, salt, 2 ** logN, r, p))
  return key.length === expect.length && timingSafeEqual(key, expect)
}

// ---------- 用户数据加密（AES-256-GCM） ----------
const MAGIC = Buffer.from('LMv1')
/** 从主密钥派生不同用途的子密钥，用户数据和 API Key 用的不是同一把 */
export function deriveKey(master: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32))
}
export function deriveDataKey(master: Buffer): Buffer {
  return deriveKey(master, 'lovememo-user-data-v1')
}
/** aad 绑定用户和版本号：文件被挪到别的用户目录下也解不开 */
export function encrypt(key: Buffer, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key, iv)
  c.setAAD(Buffer.from(aad))
  const body = Buffer.concat([c.update(plain), c.final()])
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body])
}
export function decrypt(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < 32 || !blob.subarray(0, 4).equals(MAGIC)) throw new Error('数据文件格式不对')
  const iv = blob.subarray(4, 16)
  const tag = blob.subarray(16, 32)
  const d = createDecipheriv('aes-256-gcm', key, iv)
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(tag)
  return Buffer.concat([d.update(blob.subarray(32)), d.final()])
}
