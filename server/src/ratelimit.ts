// 内存限流：固定窗口计数。键的数量有上限，防止有人用大量伪造的键把内存撑爆。
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>()
  private limit: number
  private windowMs: number
  private maxKeys: number
  constructor(limit: number, windowMs: number, maxKeys = 50_000) {
    this.limit = limit
    this.windowMs = windowMs
    this.maxKeys = maxKeys
  }

  /** 记一次并返回是否允许；不允许时返回需要等待的秒数 */
  hit(key: string, now = Date.now()): { ok: true } | { ok: false; retryAfter: number } {
    let e = this.hits.get(key)
    if (!e || e.reset <= now) {
      if (!e && this.hits.size >= this.maxKeys) this.evict(now)
      e = { n: 0, reset: now + this.windowMs }
      this.hits.set(key, e)
    }
    e.n++
    if (e.n > this.limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((e.reset - now) / 1000)) }
    return { ok: true }
  }

  private evict(now: number) {
    for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k)
    // 还是满的：删掉最早插入的一半（Map 按插入顺序遍历）
    if (this.hits.size >= this.maxKeys) {
      let drop = Math.floor(this.maxKeys / 2)
      for (const k of this.hits.keys()) { if (drop-- <= 0) break; this.hits.delete(k) }
    }
  }
}

/** 每个键同时进行的任务数上限（例如每个用户同时最多 2 个 AI 请求） */
export class Concurrency {
  private n = new Map<string, number>()
  private max: number
  constructor(max: number) { this.max = max }
  acquire(key: string): (() => void) | null {
    const c = this.n.get(key) ?? 0
    if (c >= this.max) return null
    this.n.set(key, c + 1)
    let released = false
    return () => {
      if (released) return
      released = true
      const v = (this.n.get(key) ?? 1) - 1
      if (v <= 0) this.n.delete(key); else this.n.set(key, v)
    }
  }
}
