// AI 转发：模型和 API Key 只由超级管理员在服务器上配置（models.json + 环境变量）。
// 前端只能选模型 id，不能指定地址，所以没法拿服务器去访问内网（SSRF），也拿不到 Key。
import { readFileSync, existsSync } from 'node:fs'
import type { Ctx, Req } from './context.ts'
import { HttpError, readJson, sendJson } from './http.ts'
import { requireUser } from './auth.ts'

type Route = 'recognize' | 'analyze' | 'quiz' | 'roleplay'
const ROUTES: Route[] = ['recognize', 'analyze', 'quiz', 'roleplay']
const QUIRKS = ['noTemperature', 'maxCompletionTokens', 'noResponseFormat'] as const

export interface ServerModel {
  id: string
  name: string
  protocol: 'openai' | 'anthropic'
  url: string
  model: string
  key: string | null
  supports_vision: boolean
  supports_json: boolean
  temperature: number | null
  max_tokens: number
  timeout_s: number
  quirks: Partial<Record<(typeof QUIRKS)[number], boolean>>
  price_in: number | null
  price_out: number | null
  routes: Route[]
  available: boolean
}

export interface ModelRegistry { list: ServerModel[]; byId: Map<string, ServerModel> }

function endpoint(protocol: string, base: string): string {
  const b = base.trim().replace(/\/+$/, '')
  if (protocol === 'anthropic') return /\/messages$/.test(b) ? b : /\/v1$/.test(b) ? b + '/messages' : b + '/v1/messages'
  return /\/chat\/completions$/.test(b) ? b : b + '/chat/completions'
}

function fail(i: number, msg: string): never { throw new Error(`models.json 第 ${i + 1} 项：${msg}`) }

export function loadModels(file: string, env: NodeJS.ProcessEnv = process.env): ModelRegistry {
  const list: ServerModel[] = []
  if (existsSync(file)) {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (!Array.isArray(raw)) throw new Error('models.json 必须是数组')
    raw.forEach((m: Record<string, unknown>, i) => {
      if (!m || typeof m !== 'object') fail(i, '格式不对')
      const id = String(m.id ?? '')
      if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) fail(i, 'id 只能用小写字母、数字、_ -')
      if (list.some((x) => x.id === id)) fail(i, `id ${id} 重复`)
      const protocol = m.protocol === 'anthropic' ? 'anthropic' : m.protocol === 'openai' ? 'openai' : fail(i, 'protocol 只能是 openai 或 anthropic')
      let u: URL
      try { u = new URL(String(m.base_url ?? '')) } catch { fail(i, 'base_url 不是合法地址') }
      if (u.username || u.password) fail(i, 'base_url 里不能带账号密码')
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && m.allow_http === true)) fail(i, 'base_url 必须是 https（内网模型可设置 "allow_http": true）')
      const model = String(m.model ?? '')
      if (!model || model.length > 100) fail(i, 'model 不能为空')
      let key: string | null = null
      if (m.key_env !== undefined && m.key_env !== null) {
        const ke = String(m.key_env)
        // 只允许 *_API_KEY 形式的变量名，防止配错把 DATA_KEY 之类的服务器密钥发给第三方
        if (!/^[A-Z][A-Z0-9_]{0,55}_API_KEY$/.test(ke)) fail(i, 'key_env 必须是形如 DEEPSEEK_API_KEY 的环境变量名')
        key = env[ke]?.trim() || null
        if (!key) console.warn(`[models] ${id}：环境变量 ${ke} 没有设置，这个模型暂时不可用`)
      }
      const num = (v: unknown, def: number, lo: number, hi: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def)
      const quirks: ServerModel['quirks'] = {}
      if (m.quirks && typeof m.quirks === 'object') for (const q of QUIRKS) if ((m.quirks as Record<string, unknown>)[q] === true) quirks[q] = true
      list.push({
        id, name: String(m.name ?? id).slice(0, 40), protocol, url: endpoint(protocol, u.href), model, key,
        supports_vision: m.supports_vision === true, supports_json: m.supports_json !== false,
        temperature: typeof m.temperature === 'number' ? num(m.temperature, 1, 0, 2) : null,
        max_tokens: Math.round(num(m.max_tokens, 8192, 256, 200000)), timeout_s: Math.round(num(m.timeout_s, 120, 10, 600)), quirks,
        price_in: typeof m.price_in === 'number' ? m.price_in : null, price_out: typeof m.price_out === 'number' ? m.price_out : null,
        routes: Array.isArray(m.routes) ? ROUTES.filter((r) => (m.routes as unknown[]).includes(r)) : [],
        available: m.key_env === undefined || m.key_env === null || !!key,
      })
    })
  } else {
    console.warn(`[models] 没找到 ${file}，AI 功能暂时不可用`)
  }
  return { list, byId: new Map(list.map((m) => [m.id, m])) }
}

/** 给前端的模型列表：不含地址和 Key */
export async function listModels(ctx: Ctx, r: Req) {
  requireUser(r)
  sendJson(r.res, 200, {
    models: ctx.models.list.filter((m) => m.available).map((m) => ({
      id: m.id, name: m.name, protocol: m.protocol, model: m.model, supports_vision: m.supports_vision, supports_json: m.supports_json,
      temperature: m.temperature, max_tokens: m.max_tokens, timeout_s: m.timeout_s, quirks: m.quirks, price_in: m.price_in, price_out: m.price_out, routes: m.routes,
    })),
    dailyLimit: ctx.cfg.llmDailyLimit,
  })
}

// ---------- 请求体白名单：只转发认识的字段，其余一律丢弃 ----------
const IMG_MEDIA = /^image\/(png|jpeg|gif|webp)$/
const B64 = /^[A-Za-z0-9+/]+={0,2}$/
const bad = (m: string) => new HttpError(400, 'bad_llm_body', m)

function text(v: unknown, max: number): string {
  if (typeof v !== 'string' || v.length > max) throw bad('文字内容格式不对')
  return v
}

function anthropicContent(c: unknown): unknown {
  if (typeof c === 'string') return text(c, 2_000_000)
  if (!Array.isArray(c) || c.length > 40) throw bad('消息格式不对')
  return c.map((p: Record<string, unknown>) => {
    if (p?.type === 'text') return { type: 'text', text: text(p.text, 2_000_000) }
    const s = p?.source as Record<string, unknown> | undefined
    if (p?.type === 'image' && s?.type === 'base64' && typeof s.media_type === 'string' && IMG_MEDIA.test(s.media_type) && typeof s.data === 'string' && B64.test(s.data)) {
      return { type: 'image', source: { type: 'base64', media_type: s.media_type, data: s.data } }
    }
    throw bad('消息里有不支持的内容')
  })
}

function openaiContent(c: unknown): unknown {
  if (typeof c === 'string') return text(c, 2_000_000)
  if (!Array.isArray(c) || c.length > 40) throw bad('消息格式不对')
  return c.map((p: Record<string, unknown>) => {
    if (p?.type === 'text') return { type: 'text', text: text(p.text, 2_000_000) }
    const url = (p?.image_url as Record<string, unknown> | undefined)?.url
    // 只接受内嵌的图片数据，不接受网址
    if (p?.type === 'image_url' && typeof url === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(url)) return { type: 'image_url', image_url: { url } }
    throw bad('消息里有不支持的内容')
  })
}

function clampTokens(v: unknown, cap: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? Math.min(v, cap) : cap
}

export function sanitize(m: ServerModel, b: Record<string, unknown>): Record<string, unknown> {
  const msgs = b.messages
  if (!Array.isArray(msgs) || msgs.length < 1 || msgs.length > 200) throw bad('消息格式不对')
  const out: Record<string, unknown> = { model: m.model }
  const temp = typeof b.temperature === 'number' && b.temperature >= 0 && b.temperature <= 2 && !m.quirks.noTemperature ? b.temperature : undefined
  if (m.protocol === 'anthropic') {
    if (b.system !== undefined) out.system = text(b.system, 500_000)
    out.messages = msgs.map((x: Record<string, unknown>) => {
      if (x?.role !== 'user' && x?.role !== 'assistant') throw bad('消息角色不对')
      return { role: x.role, content: anthropicContent(x.content) }
    })
    out.max_tokens = clampTokens(b.max_tokens, m.max_tokens)
  } else {
    out.messages = msgs.map((x: Record<string, unknown>) => {
      if (x?.role !== 'user' && x?.role !== 'assistant' && x?.role !== 'system') throw bad('消息角色不对')
      return { role: x.role, content: openaiContent(x.content) }
    })
    if (b.max_completion_tokens !== undefined) out.max_completion_tokens = clampTokens(b.max_completion_tokens, m.max_tokens)
    else out.max_tokens = clampTokens(b.max_tokens, m.max_tokens)
    const rf = b.response_format as Record<string, unknown> | undefined
    if (rf && rf.type === 'json_object' && Object.keys(rf).length === 1) out.response_format = { type: 'json_object' }
  }
  if (temp !== undefined) out.temperature = temp
  return out
}

const MAX_RESP = 10 * 1024 * 1024
async function readCapped(resp: Response): Promise<string> {
  if (!resp.body) return ''
  const reader = resp.body.getReader()
  const chunks: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > MAX_RESP) { await reader.cancel(); throw new HttpError(502, 'upstream_too_large', '模型返回的内容太大了') }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function today() { return new Date().toISOString().slice(0, 10) }

export async function proxy(ctx: Ctx, r: Req) {
  const a = requireUser(r)
  const rl = ctx.limits.llmUser.hit(a.user.id)
  if (!rl.ok) throw new HttpError(429, 'rate_limited', 'AI 请求太频繁了，歇一会儿再试', { retryAfter: rl.retryAfter })
  const used = (ctx.db.prepare('SELECT calls FROM llm_usage WHERE user_id = ? AND day = ?').get(a.user.id, today()) as { calls: number } | undefined)?.calls ?? 0
  if (used >= ctx.cfg.llmDailyLimit) throw new HttpError(429, 'quota', `今天的 AI 次数（${ctx.cfg.llmDailyLimit} 次）用完了，明天再来吧`)
  const release = ctx.limits.llmConcurrent.acquire(a.user.id)
  if (!release) throw new HttpError(429, 'busy', '上一个 AI 请求还没结束，请稍等')
  try {
    const body = await readJson(r.req, ctx.cfg.maxLlmBodyBytes)
    const m = typeof body.profileId === 'string' ? ctx.models.byId.get(body.profileId) : undefined
    if (!m || !m.available) throw new HttpError(404, 'no_model', '这个模型不可用了，请到设置里重新选择')
    if (!body.body || typeof body.body !== 'object' || Array.isArray(body.body)) throw bad('请求格式不对')
    const outBody = JSON.stringify(sanitize(m, body.body as Record<string, unknown>))
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (m.protocol === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01'
      if (m.key) headers['x-api-key'] = m.key
    } else if (m.key) headers.authorization = `Bearer ${m.key}`

    ctx.db.prepare('INSERT INTO llm_usage (user_id, day, calls) VALUES (?, ?, 1) ON CONFLICT (user_id, day) DO UPDATE SET calls = calls + 1').run(a.user.id, today())
    let resp: Response
    try {
      // 不跟随重定向：防止上游把请求引到别处
      resp = await fetch(m.url, { method: 'POST', headers, body: outBody, redirect: 'error', signal: AbortSignal.timeout(m.timeout_s * 1000) })
    } catch (e) {
      const name = (e as Error).name
      sendJson(r.res, 200, { status: 0, body: name === 'TimeoutError' ? '请求超时了，可以稍后再试' : '连不上模型服务，请稍后再试' })
      return
    }
    const respText = await readCapped(resp)
    try {
      const j = JSON.parse(respText) as { usage?: Record<string, number> }
      const tin = j.usage?.input_tokens ?? j.usage?.prompt_tokens ?? 0
      const tout = j.usage?.output_tokens ?? j.usage?.completion_tokens ?? 0
      if (Number.isFinite(tin) && Number.isFinite(tout)) ctx.db.prepare('UPDATE llm_usage SET tin = tin + ?, tout = tout + ? WHERE user_id = ? AND day = ?').run(Math.trunc(tin), Math.trunc(tout), a.user.id, today())
    } catch { /* 非 JSON 响应，不记 token */ }
    sendJson(r.res, 200, { status: resp.status, body: respText })
  } finally {
    release()
  }
}
