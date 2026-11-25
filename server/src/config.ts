// 服务端配置：全部来自环境变量。缺少关键配置时拒绝启动，不提供"调试模式"之类的降级开关。
import { resolve } from 'node:path'

export interface Config {
  host: string
  port: number
  /** 用户访问的完整地址，例如 https://memo.example.com。用于 Origin 校验、Host 校验和 Cookie 的 Secure 属性 */
  publicOrigin: string
  publicHost: string
  secureCookies: boolean
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const originRaw = env.PUBLIC_ORIGIN
  if (!originRaw) throw new Error('缺少 PUBLIC_ORIGIN，例如 https://memo.example.com')
  let origin: URL
  try { origin = new URL(originRaw) } catch { throw new Error('PUBLIC_ORIGIN 不是合法地址') }
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error('PUBLIC_ORIGIN 只能包含协议、域名和端口，例如 https://memo.example.com')
  }
  if (origin.protocol !== 'https:') {
    // 明文 http 只允许本机调试；公网必须 https，否则 Cookie 和密码会被窃听
    if (origin.protocol !== 'http:' || !LOOPBACK.has(origin.hostname)) throw new Error('PUBLIC_ORIGIN 必须是 https 地址（只有 localhost 调试时可以用 http）')
  }
  const dataDir = resolve(env.DATA_DIR || './data')
  return {
    host: env.HOST || '127.0.0.1',
    port: int('PORT', 8787, 1, 65535, env),
    publicOrigin: origin.origin,
    publicHost: origin.host,
    secureCookies: origin.protocol === 'https:',
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
