// 各模块共用的运行时上下文
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Config } from './config.ts'
import type { DB, UserRow } from './db.ts'
import type { RateLimiter, Concurrency } from './ratelimit.ts'
import type { UserData } from './userdata.ts'

export interface Ctx {
  cfg: Config
  db: DB
  data: UserData
  /** 加密 AI 服务商 API Key 用的子密钥（由 DATA_KEY 派生） */
  providerKey: Buffer
  /** 首次安装码的 SHA-256；已经有用户后为 null */
  setup: { codeHash: string | null }
  /** 不存在的用户也做一次同样耗时的哈希校验，避免通过响应时间判断用户名是否存在 */
  dummyHash: string
  limits: {
    global: RateLimiter
    authIp: RateLimiter
    setupIp: RateLimiter
    registerIp: RateLimiter
    inviteFailIp: RateLimiter
    llmUser: RateLimiter
    adminProbe: RateLimiter
    llmConcurrent: Concurrency
  }
}

export interface Auth {
  user: UserRow
  sessionHash: string
  kind: 'web' | 'desktop'
}

export interface Req {
  req: IncomingMessage
  res: ServerResponse
  url: URL
  ip: string
  auth: Auth | null
}
