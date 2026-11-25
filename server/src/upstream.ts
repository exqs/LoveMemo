// 访问 AI 服务商的 HTTP 客户端。
// 管理员可以填任意端点地址，所以每次连接前都检查域名解析出来的 IP：默认不允许连到内网、本机、
// 云服务器元数据地址（169.254.169.254）等。检查发生在真正建立连接的那一刻，DNS 重绑定也绕不过去。
// 不跟随重定向，响应大小有上限。
import http from 'node:http'
import https from 'node:https'
import { lookup as dnsLookup, promises as dnsPromises, type LookupAddress } from 'node:dns'
import { BlockList, isIP } from 'node:net'

const blocked = new BlockList()
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(a, p, 'ipv4')
for (const [a, p] of [
  // 不写 ::ffff:0:0/96：BlockList 会把 IPv4 地址当成映射地址去匹配，写了会把所有 IPv4 都拦掉。
  // IPv4 映射地址（::ffff:127.0.0.1 这类）由上面的 IPv4 规则自动覆盖
  ['::', 127], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(a, p, 'ipv6')

export function isBlockedIp(addr: string): boolean {
  const fam = isIP(addr)
  if (fam === 4) return blocked.check(addr, 'ipv4')
  if (fam === 6) return blocked.check(addr, 'ipv6')
  return true
}

export class UpstreamError extends Error {
  kind: 'blocked' | 'bad_url' | 'timeout' | 'network' | 'too_large'
  constructor(kind: UpstreamError['kind'], message: string) {
    super(message)
    this.kind = kind
  }
}

/** 检查端点地址本身（协议、账号密码、直接写 IP 的情况）。域名解析后的检查在连接时做 */
export function checkUrl(raw: string, allowPrivate: boolean): URL {
  let u: URL
  try { u = new URL(raw) } catch { throw new UpstreamError('bad_url', '端点地址格式不对') }
  if (u.username || u.password) throw new UpstreamError('bad_url', '端点地址里不能带账号密码')
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && allowPrivate)) {
    throw new UpstreamError('bad_url', allowPrivate ? '端点地址只能是 http 或 https' : '端点地址必须是 https 开头')
  }
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) && !allowPrivate && isBlockedIp(host)) throw new UpstreamError('blocked', '这个地址指向服务器内网或本机，默认不允许')
  return u
}

/** 保存地址前先解析一次域名，指向内网就直接提示（真正连接时还会再检查） */
export async function checkResolves(u: URL, allowPrivate: boolean): Promise<void> {
  if (allowPrivate) return
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host)) return
  let list: LookupAddress[]
  try { list = await dnsPromises.lookup(host, { all: true }) } catch { throw new UpstreamError('network', '找不到这个域名') }
  if (!list.length || list.some((a) => isBlockedIp(a.address))) throw new UpstreamError('blocked', '这个地址指向服务器内网或本机，默认不允许')
}

export interface UpstreamResp { status: number; text: string }

export function upstreamRequest(url: string, o: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number; allowPrivate: boolean }): Promise<UpstreamResp> {
  return new Promise((resolve, reject) => {
    let u: URL
    try { u = checkUrl(url, o.allowPrivate) } catch (e) { reject(e); return }
    let settled = false
    const fail = (e: UpstreamError) => { if (!settled) { settled = true; reject(e) } }

    const lookup = (hostname: string, opts: { family?: number; all?: boolean }, cb: (...args: unknown[]) => void) => {
      dnsLookup(hostname, { all: true, family: opts?.family ?? 0 }, (err, addrs) => {
        if (err) { cb(err); return }
        const list = addrs as LookupAddress[]
        if (!list.length) { cb(new Error('找不到这个域名')); return }
        // 只要有一个解析结果是内网地址就拒绝，不去挑"安全"的那个
        if (!o.allowPrivate && list.some((a) => isBlockedIp(a.address))) {
          cb(Object.assign(new Error('blocked'), { code: 'LM_BLOCKED' }))
          return
        }
        if (opts?.all) cb(null, list)
        else cb(null, list[0].address, list[0].family)
      })
    }

    const headers: Record<string, string> = { ...o.headers, 'user-agent': 'LoveMemo-Server' }
    if (o.body !== undefined) headers['content-length'] = String(Buffer.byteLength(o.body))
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request(u, { method: o.method, headers, lookup: lookup as never, agent: false })
    const timer = setTimeout(() => { fail(new UpstreamError('timeout', '请求超时了')); req.destroy() }, o.timeoutMs)
    req.on('response', (res) => {
      const chunks: Buffer[] = []
      let n = 0
      res.on('data', (c: Buffer) => {
        n += c.length
        if (n > o.maxBytes) { fail(new UpstreamError('too_large', '返回的内容太大了')); req.destroy(); return }
        chunks.push(c)
      })
      res.on('end', () => {
        clearTimeout(timer)
        if (!settled) { settled = true; resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }) }
      })
      res.on('error', () => { clearTimeout(timer); fail(new UpstreamError('network', '连接中断了')) })
    })
    req.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (e.code === 'LM_BLOCKED') fail(new UpstreamError('blocked', '这个地址指向服务器内网或本机，默认不允许'))
      else if (e.code === 'ENOTFOUND' || e.code === 'EAI_AGAIN') fail(new UpstreamError('network', '找不到这个域名'))
      else fail(new UpstreamError('network', '连不上这个地址'))
    })
    if (o.body !== undefined) req.write(o.body)
    req.end()
  })
}
