// 请求入口：Host 校验 → 全局限流 → 安全头 → 跨站请求校验 → 认证 → 路由
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { Config } from './config.ts'
import type { Ctx, Req } from './context.ts'
import { audit, housekeeping, openDb } from './db.ts'
import { BusyError, hashPassword, humanCode, normalizeCode, sha256Hex } from './crypto.ts'
import { HttpError, clientIp, readBody, securityHeaders, sendJson } from './http.ts'
import { Concurrency, RateLimiter } from './ratelimit.ts'
import { UserData } from './userdata.ts'
import { loadModels, listModels, proxy } from './llm.ts'
import { staticHandler } from './static.ts'
import * as auth from './auth.ts'
import * as admin from './admin.ts'

export async function createContext(cfg: Config): Promise<Ctx> {
  const db = openDb(cfg.dataDir)
  const ctx: Ctx = {
    cfg, db,
    data: new UserData(cfg.dataDir, cfg.dataKey, db),
    models: loadModels(cfg.modelsFile),
    setup: { codeHash: null },
    dummyHash: await hashPassword(randomBytes(24).toString('base64'), cfg.scryptLogN),
    limits: {
      global: new RateLimiter(600, 60_000),
      authIp: new RateLimiter(20, 15 * 60_000),
      setupIp: new RateLimiter(10, 60 * 60_000),
      registerIp: new RateLimiter(10, 60 * 60_000),
      inviteFailIp: new RateLimiter(5, 60 * 60_000),
      llmUser: new RateLimiter(cfg.llmPerMinute, 60_000),
      llmConcurrent: new Concurrency(2),
    },
  }
  return ctx
}

/** 没有任何用户时生成一次性安装码，只打印在服务器日志里。返回明文供调用方打印 */
export function prepareSetupCode(ctx: Ctx): string | null {
  if (auth.userCount(ctx) > 0) { ctx.setup.codeHash = null; return null }
  const code = humanCode(5)
  ctx.setup.codeHash = sha256Hex(normalizeCode(code))
  return code
}

async function getData(ctx: Ctx, r: Req) {
  const a = auth.requireUser(r)
  const { version, bytes } = await ctx.data.read(a.user.id)
  r.res.setHeader('X-Data-Version', String(version))
  r.res.setHeader('X-Data-Owner', a.user.id)
  r.res.setHeader('Cache-Control', 'no-store')
  if (!bytes) { r.res.statusCode = 204; r.res.end(); return }
  r.res.statusCode = 200
  r.res.setHeader('Content-Type', 'application/octet-stream')
  r.res.setHeader('Content-Disposition', 'attachment; filename="data.sqlite"')
  r.res.setHeader('Content-Length', bytes.length)
  r.res.end(bytes)
}

async function putData(ctx: Ctx, r: Req) {
  const a = auth.requireUser(r)
  const ct = String(r.req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (ct !== 'application/octet-stream') throw new HttpError(415, 'bad_type', '请求格式不对')
  // 客户端必须说明这份数据是谁的：页面上是 A 的数据、Cookie 却换成了 B 的时候，拒绝写入，防止把 A 的数据存进 B 的账号
  if (r.req.headers['x-data-owner'] !== a.user.id) throw new HttpError(409, 'wrong_owner', '登录的账号变了，请刷新页面')
  const base = Number(r.req.headers['x-data-version'])
  if (!Number.isInteger(base) || base < 0) throw new HttpError(400, 'bad_version', '缺少数据版本号')
  const buf = await readBody(r.req, ctx.cfg.maxDataBytes)
  const version = await ctx.data.write(a.user.id, base, buf)
  sendJson(r.res, 200, { version })
}

type Handler = (ctx: Ctx, r: Req, param: string) => Promise<void>
const ROUTES: [string, RegExp, Handler][] = [
  ['GET', /^\/api\/health$/, async (_c, r) => sendJson(r.res, 200, { ok: true })],
  ['GET', /^\/api\/auth\/state$/, auth.state],
  ['POST', /^\/api\/auth\/setup$/, auth.setup],
  ['POST', /^\/api\/auth\/login$/, auth.login],
  ['POST', /^\/api\/auth\/logout$/, auth.logout],
  ['POST', /^\/api\/auth\/register$/, auth.register],
  ['POST', /^\/api\/account\/password$/, auth.changePassword],
  ['POST', /^\/api\/account\/logout-all$/, auth.logoutAll],
  ['GET', /^\/api\/account\/sessions$/, auth.sessions],
  ['GET', /^\/api\/data$/, getData],
  ['PUT', /^\/api\/data$/, putData],
  ['GET', /^\/api\/models$/, listModels],
  ['POST', /^\/api\/llm$/, proxy],
  ['GET', /^\/api\/admin\/invites$/, admin.listInvites],
  ['POST', /^\/api\/admin\/invites$/, admin.createInvite],
  ['POST', /^\/api\/admin\/invites\/([0-9a-f-]{36})\/revoke$/, (c, r, id) => admin.revokeInvite(c, r, id)],
  ['GET', /^\/api\/admin\/users$/, admin.listUsers],
  ['POST', /^\/api\/admin\/users\/([0-9a-f-]{36})\/disable$/, (c, r, id) => admin.setDisabled(c, r, id, true)],
  ['POST', /^\/api\/admin\/users\/([0-9a-f-]{36})\/enable$/, (c, r, id) => admin.setDisabled(c, r, id, false)],
  ['POST', /^\/api\/admin\/users\/([0-9a-f-]{36})\/delete$/, (c, r, id) => admin.deleteUser(c, r, id)],
  ['GET', /^\/api\/admin\/audit$/, admin.listAudit],
]

/**
 * 跨站请求防护（CSRF）。会改数据的请求必须：
 * 1. 带自定义头 X-LoveMemo: 1 —— 别的网站的脚本要带这个头必须先过 CORS 预检，而我们从不回应 CORS；
 * 2. 如果浏览器带了 Origin，必须正好是本站；
 * 3. 如果浏览器带了 Sec-Fetch-Site，必须是 same-origin（桌面端由 Rust 发请求，不带这两个头）。
 * 另外 Cookie 本身是 SameSite=Strict。
 */
function checkCsrf(ctx: Ctx, req: IncomingMessage) {
  if (req.method === 'GET' || req.method === 'HEAD') return
  if (req.headers['x-lovememo'] !== '1') throw new HttpError(403, 'csrf', '请求来源不对')
  const origin = req.headers.origin
  if (origin !== undefined && origin !== ctx.cfg.publicOrigin) throw new HttpError(403, 'csrf', '请求来源不对')
  const site = req.headers['sec-fetch-site']
  if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'csrf', '请求来源不对')
}

export function createHandler(ctx: Ctx) {
  const serveStatic = staticHandler(ctx.cfg.staticDir)
  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const ip = clientIp(req, ctx.cfg.trustProxy)
    let url: URL
    try { url = new URL(req.url ?? '/', 'http://x') } catch { res.statusCode = 400; res.end(); return }
    const r: Req = { req, res, url, ip, auth: null }
    try {
      securityHeaders(res, ctx.cfg)
      // Host 必须是配置的域名（容器健康检查除外），防止 DNS 重绑定和用 IP 直接访问绕过反代
      if (req.headers.host !== ctx.cfg.publicHost && url.pathname !== '/api/health') throw new HttpError(421, 'bad_host', 'Misdirected Request')
      const g = ctx.limits.global.hit(ip)
      if (!g.ok) throw new HttpError(429, 'rate_limited', '访问太频繁了，请稍后再试', { retryAfter: g.retryAfter })

      if (url.pathname.startsWith('/api/')) {
        const route = ROUTES.find(([m, re]) => m === req.method && re.test(url.pathname))
        if (!route) throw new HttpError(ROUTES.some(([, re]) => re.test(url.pathname)) ? 405 : 404, 'not_found', '没有这个接口')
        checkCsrf(ctx, req)
        r.auth = auth.authenticate(ctx, r)
        const param = route[1].exec(url.pathname)?.[1] ?? ''
        await route[2](ctx, r, param)
        return
      }
      if (await serveStatic(req, res, url.pathname)) return
      throw new HttpError(404, 'not_found', 'Not Found')
    } catch (e) {
      if (res.headersSent) { res.destroy(); return }
      if (e instanceof HttpError) {
        if (e.extra?.retryAfter) res.setHeader('Retry-After', String(e.extra.retryAfter))
        sendJson(res, e.status, { error: e.code, message: e.message, ...(e.extra ?? {}) })
      } else if (e instanceof BusyError) {
        sendJson(res, 503, { error: 'busy', message: '服务器有点忙，请稍后再试' })
      } else {
        // 不把内部错误细节返回给客户端
        console.error('[error]', req.method, url.pathname, e)
        sendJson(res, 500, { error: 'internal', message: '服务器出了点问题，请稍后再试' })
      }
    }
  }
}

export function createHttpServer(ctx: Ctx): Server {
  const server = createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 120_000, headersTimeout: 20_000, keepAliveTimeout: 5_000 }, createHandler(ctx))
  server.maxHeadersCount = 64
  const idleMs = ctx.cfg.sessionIdleDays * 86400_000
  housekeeping(ctx.db, idleMs)
  const t = setInterval(() => { try { housekeeping(ctx.db, idleMs) } catch (e) { console.error(e) } }, 3600_000)
  t.unref()
  server.on('close', () => clearInterval(t))
  audit(ctx.db, 'server_start')
  return server
}
