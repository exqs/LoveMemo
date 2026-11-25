// 测试工具：在随机端口启动一个独立的服务端实例（独立的临时数据目录），用原始 HTTP 请求测试
import { request } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { loadConfig } from '../src/config.ts'
import { createContext, createHttpServer, prepareSetupCode } from '../src/app.ts'
import type { Ctx } from '../src/context.ts'

export const HOST = 'memo.test'
export const ORIGIN = 'https://memo.test'

export interface Res { status: number; headers: Record<string, string | string[] | undefined>; text: string; body: Buffer; json: any } // eslint-disable-line @typescript-eslint/no-explicit-any

export interface ReqOpts {
  method?: string
  headers?: Record<string, string>
  json?: unknown
  raw?: Buffer | string
  cookie?: string
  bearer?: string
  /** 不自动加 X-LoveMemo 头（测试跨站请求防护） */
  noCsrfHeader?: boolean
}

export interface TestServer {
  ctx: Ctx
  port: number
  setupCode: string
  dir: string
  req(path: string, o?: ReqOpts): Promise<Res>
  close(): Promise<void>
}

export async function startServer(env: Record<string, string> = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'lovememo-test-'))
  const cfg = loadConfig({
    PUBLIC_ORIGIN: ORIGIN, DATA_DIR: join(dir, 'data'), DATA_KEY: randomBytes(32).toString('base64'),
    SCRYPT_LOG_N: '15', STATIC_DIR: join(dir, 'static'), ...env,
  })
  const ctx = await createContext(cfg)
  const setupCode = prepareSetupCode(ctx) ?? ''
  const server = createHttpServer(ctx)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as AddressInfo).port

  const req = (path: string, o: ReqOpts = {}) => new Promise<Res>((resolve, reject) => {
    const headers: Record<string, string> = { host: HOST, ...(o.noCsrfHeader ? {} : { 'x-lovememo': '1' }), ...(o.headers ?? {}) }
    let payload: Buffer | undefined
    if (o.json !== undefined) { payload = Buffer.from(JSON.stringify(o.json)); headers['content-type'] ??= 'application/json' }
    if (o.raw !== undefined) payload = Buffer.isBuffer(o.raw) ? o.raw : Buffer.from(o.raw)
    if (payload) headers['content-length'] = String(payload.length)
    if (o.cookie) headers.cookie = o.cookie
    if (o.bearer) headers.authorization = `Bearer ${o.bearer}`
    const r = request({ host: '127.0.0.1', port, path, method: o.method ?? (payload ? 'POST' : 'GET'), headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        const text = body.toString('utf8')
        let json: unknown = null
        try { json = JSON.parse(text) } catch { /* 非 JSON */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, body, json })
      })
    })
    r.on('error', reject)
    if (payload) r.write(payload)
    r.end()
  })

  return {
    ctx, port, setupCode, dir, req,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections()
      server.close(() => { ctx.db.close(); rmSync(dir, { recursive: true, force: true }); r() })
    }),
  }
}

/** 从 Set-Cookie 里取出会话 Cookie，返回可以直接放进 Cookie 头的字符串 */
export function sessionCookie(res: Res): string {
  const sc = res.headers['set-cookie']
  const list = Array.isArray(sc) ? sc : sc ? [sc] : []
  const c = list.find((x) => x.startsWith('__Host-lm_sid=') || x.startsWith('lm_sid='))
  if (!c) throw new Error('没有会话 Cookie')
  return c.split(';')[0]
}

export const ADMIN = { username: 'Admin柒', password: 'correct horse battery 9' }

export async function setupAdmin(s: TestServer): Promise<string> {
  const r = await s.req('/api/auth/setup', { json: { setupCode: s.setupCode, ...ADMIN } })
  if (r.status !== 201) throw new Error('setup failed: ' + r.text)
  return login(s, ADMIN.username, ADMIN.password)
}

export async function login(s: TestServer, username: string, password: string): Promise<string> {
  const r = await s.req('/api/auth/login', { json: { username, password } })
  if (r.status !== 200) throw new Error('login failed: ' + r.text)
  return sessionCookie(r)
}

export async function invite(s: TestServer, adminCookie: string, maxUses = 1, expiresHours = 72): Promise<{ id: string; code: string }> {
  const r = await s.req('/api/admin/invites', { cookie: adminCookie, json: { maxUses, expiresHours } })
  if (r.status !== 201) throw new Error('invite failed: ' + r.text)
  return r.json
}

export async function registerUser(s: TestServer, adminCookie: string, username: string, password = 'another good pass 42'): Promise<string> {
  const inv = await invite(s, adminCookie)
  const r = await s.req('/api/auth/register', { json: { inviteCode: inv.code, username, password } })
  if (r.status !== 201) throw new Error('register failed: ' + r.text)
  return login(s, username, password)
}

/** 最小的合法 SQLite 文件头 + 填充 */
export function fakeSqlite(fill = 1, size = 4096): Buffer {
  const b = Buffer.alloc(size, fill)
  Buffer.from('SQLite format 3\0', 'latin1').copy(b, 0)
  return b
}

/** 管理员添加一个服务商并选中模型，返回 { providerId, models: [{id, model}] } */
export async function addProvider(s: TestServer, adminCookie: string, o: { base_url: string; api_key?: string; protocol?: 'openai' | 'anthropic'; models: string[]; name?: string }) {
  const r = await s.req('/api/admin/llm/providers', { cookie: adminCookie, json: { protocol: o.protocol ?? 'openai', name: o.name ?? 'Mock', base_url: o.base_url, api_key: o.api_key ?? '', models: o.models, password: ADMIN.password } })
  if (r.status !== 201) throw new Error('add provider failed: ' + r.text)
  const list = await s.req('/api/admin/llm', { cookie: adminCookie })
  const p = list.json.providers.find((x: { id: string }) => x.id === r.json.id)
  return { providerId: r.json.id as string, models: p.models as { id: string; model: string }[] }
}
