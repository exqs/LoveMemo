// HTTP 工具：请求体读取（有大小上限）、JSON 响应、安全响应头、Cookie、客户端 IP
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config } from './config.ts'

export class HttpError extends Error {
  status: number
  code: string
  extra?: Record<string, unknown>
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

export function securityHeaders(res: ServerResponse, cfg: Config) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    // sql.js 需要编译 WebAssembly；不允许任何内联脚本和 eval
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  // 浏览器只在 https（或本机）下认这个头，http 下发了只会在控制台报警告
  if (!cfg.plainHttp) res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()')
  // 只管本站，不带 includeSubDomains：同一域名下别的子站点以后想用 http 也不受影响
  if (cfg.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000')
}

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', Buffer.byteLength(s))
  res.end(s)
}

/** 读取请求体，超过 limit 立即断开，不把整个超大请求读进内存 */
export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0)
    if (declared > limit) { reject(new HttpError(413, 'too_large', '内容太大了')); req.resume(); return }
    const chunks: Buffer[] = []
    let size = 0
    let done = false
    req.on('data', (c: Buffer) => {
      if (done) return
      size += c.length
      if (size > limit) {
        done = true
        reject(new HttpError(413, 'too_large', '内容太大了'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks)) } })
    req.on('error', (e) => { if (!done) { done = true; reject(e) } })
  })
}

export async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  if (ct !== 'application/json') throw new HttpError(415, 'bad_type', '请求格式不对')
  const buf = await readBody(req, limit)
  let v: unknown
  try { v = JSON.parse(buf.toString('utf8')) } catch { throw new HttpError(400, 'bad_json', '请求格式不对') }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'bad_json', '请求格式不对')
  return v as Record<string, unknown>
}

export function str(o: Record<string, unknown>, k: string, max: number): string {
  const v = o[k]
  if (typeof v !== 'string') throw new HttpError(400, 'bad_field', `缺少 ${k}`)
  if (v.length > max) throw new HttpError(400, 'bad_field', `${k} 太长了`)
  return v
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const m = new Map<string, string>()
  if (!header) return m
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k && !m.has(k)) m.set(k, v)
  }
  return m
}

/**
 * 客户端 IP。只有配置了 TRUST_PROXY 才读 X-Forwarded-For，并且从右往左数：
 * 最右边的几项是我们自己的代理加的，再往左的内容客户端可以随便伪造。
 */
export function clientIp(req: IncomingMessage, trustProxy: number): string {
  const direct = req.socket.remoteAddress ?? ''
  // 直接连进来的不是内网代理（比如端口被误暴露到公网），就不信任它带的转发头
  if (trustProxy <= 0 || !isPrivateAddr(direct)) return direct
  const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  if (xff.length < trustProxy) return direct
  return xff[xff.length - trustProxy] || direct
}

function isPrivateAddr(a: string): boolean {
  const v4 = a.startsWith('::ffff:') ? a.slice(7) : a
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) {
    const [x, y] = v4.split('.').map(Number)
    return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)
  }
  return a === '::1' || /^f[cd]/i.test(a)
}
