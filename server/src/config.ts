// 服务端配置：全部来自环境变量。缺少关键配置时拒绝启动，不提供"调试模式"之类的降级开关。
import { resolve } from 'node:path'

export interface Config {
  host: string
  port: number
  /** 用户访问的完整地址，例如 https://memo.example.com。用于 Origin 校验、Host 校验和 Cookie 的 Secure 属性 */
  publicOrigin: string
  publicHost: string
  secureCookies: boolean
  /** 不加密的 http，而且不是本机调试（启动时提醒，部分只在 https 下有意义的响应头不发） */
  plainHttp: boolean
  dataDir: string
  staticDir: string
  /** 允许 AI 服务商地址指向内网或本机（例如自己部署的 Ollama）。默认关闭 */
  allowPrivateLlm: boolean
  /** 32 字节主密钥：用户数据落盘加密 */
  dataKey: Buffer
  /** 反向代理层数。0 = 直接面对公网，不信任 X-Forwarded-For */
  trustProxy: number
  maxDataBytes: number
  maxLlmBodyBytes: number
  llmDailyLimit: number
  llmPerMinute: number
  sessionDays: number
  sessionIdleDays: number
  scryptLogN: number
}

function int(name: string, def: number, min: number, max: number, env: NodeJS.ProcessEnv): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} 必须是 ${min}~${max} 之间的整数`)
  return n
}

function parseKey(raw: string | undefined): Buffer {
  if (!raw) throw new Error('缺少 DATA_KEY（32 字节随机密钥，base64 或 64 位十六进制）。可用 `openssl rand -base64 32` 生成')
  const s = raw.trim()
  const buf = /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64')
  if (buf.length !== 32) throw new Error('DATA_KEY 长度不对：解码后必须正好 32 字节')
  if (buf.every((b) => b === buf[0])) throw new Error('DATA_KEY 不能是重复字节，请用随机生成的密钥')
  return buf
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
// 域名或 IPv4，不带端口和路径
const HOST_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i

/**
 * 对外地址有两种写法：
 * 1. SCHEME（https 或 http）+ DOMAIN，Docker 部署用这种
 * 2. PUBLIC_ORIGIN 完整地址，本机开发和测试用
 * 不是本机的 http 地址必须明确写 SCHEME=http 才允许，避免误配成不加密
 */
function resolveOrigin(env: NodeJS.ProcessEnv): URL {
  const scheme = env.SCHEME?.trim().toLowerCase() || undefined
  if (scheme !== undefined && scheme !== 'https' && scheme !== 'http') {
    throw new Error(`访问方式只能是 https 或 http，现在是「${env.SCHEME}」。Docker 部署请检查 deploy/.env 里的 COMPOSE_PROFILES`)
  }
  let raw = env.PUBLIC_ORIGIN?.trim()
  if (!raw) {
    const domain = env.DOMAIN?.trim()
    if (!scheme || !domain) throw new Error('缺少对外地址：请设置 SCHEME（https 或 http）和 DOMAIN，或者直接设置 PUBLIC_ORIGIN')
    if (!HOST_RE.test(domain)) throw new Error(`DOMAIN 只填域名或 IP，不要带 http://、端口或路径。现在是「${domain}」`)
    raw = `${scheme}://${domain}`
  }
  let origin: URL
  try { origin = new URL(raw) } catch { throw new Error('PUBLIC_ORIGIN 不是合法地址') }
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('PUBLIC_ORIGIN 只能包含协议、域名和端口，例如 https://memo.example.com')
  }
  if (origin.protocol !== 'https:' && origin.protocol !== 'http:') throw new Error('PUBLIC_ORIGIN 必须是 https 或 http 地址')
  if (scheme && origin.protocol !== `${scheme}:`) throw new Error(`SCHEME=${scheme} 和 PUBLIC_ORIGIN=${origin.origin} 的协议不一致`)
  if (origin.protocol === 'http:' && !LOOPBACK.has(origin.hostname) && scheme !== 'http') {
    throw new Error('PUBLIC_ORIGIN 是 http 地址，传输不加密。确定要这样用的话请同时设置 SCHEME=http')
  }
  return origin
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const origin = resolveOrigin(env)
  const dataDir = resolve(env.DATA_DIR || './data')
  return {
    host: env.HOST || '127.0.0.1',
    port: int('PORT', 8787, 1, 65535, env),
    publicOrigin: origin.origin,
    publicHost: origin.host,
    secureCookies: origin.protocol === 'https:',
    plainHttp: origin.protocol === 'http:' && !LOOPBACK.has(origin.hostname),
    dataDir,
    staticDir: resolve(env.STATIC_DIR || './dist'),
    allowPrivateLlm: env.ALLOW_PRIVATE_LLM_HOSTS === '1' || env.ALLOW_PRIVATE_LLM_HOSTS === 'true',
    dataKey: parseKey(env.DATA_KEY),
    trustProxy: int('TRUST_PROXY', 0, 0, 5, env),
    maxDataBytes: int('MAX_DATA_MB', 50, 1, 500, env) * 1024 * 1024,
    maxLlmBodyBytes: int('MAX_LLM_BODY_MB', 20, 1, 100, env) * 1024 * 1024,
    llmDailyLimit: int('LLM_DAILY_LIMIT', 300, 0, 100000, env),
    llmPerMinute: int('LLM_PER_MINUTE', 20, 1, 1000, env),
    sessionDays: int('SESSION_DAYS', 30, 1, 365, env),
    sessionIdleDays: int('SESSION_IDLE_DAYS', 7, 1, 365, env),
    // 2^17 = OWASP 推荐的 scrypt 参数（约 128MB 内存）。下限 2^15
    scryptLogN: int('SCRYPT_LOG_N', 17, 15, 20, env),
  }
}
