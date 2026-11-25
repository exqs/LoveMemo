// AI 转发：服务商、模型和 API Key 由超级管理员在管理页配置（见 providers.ts）。
// 前端只能按 id 选已开启的模型，不能指定地址，也拿不到 Key。
import type { Ctx, Req } from './context.ts'
import { HttpError, readJson, sendJson } from './http.ts'
import { requireUser } from './auth.ts'
import { usableModel, usableModels, type ServerModel } from './providers.ts'
import { UpstreamError, upstreamRequest } from './upstream.ts'

/** 给前端的模型列表：不含地址和 Key */
export async function listModels(ctx: Ctx, r: Req) {
  requireUser(r)
  sendJson(r.res, 200, {
    models: usableModels(ctx).map((m) => ({
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
    const m = typeof body.profileId === 'string' && body.profileId.length <= 64 ? usableModel(ctx, body.profileId) : null
    if (!m) throw new HttpError(404, 'no_model', '这个模型不可用了，请到设置里重新选择')
    if (!body.body || typeof body.body !== 'object' || Array.isArray(body.body)) throw bad('请求格式不对')
    const outBody = JSON.stringify(sanitize(m, body.body as Record<string, unknown>))
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (m.protocol === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01'
      if (m.key) headers['x-api-key'] = m.key
    } else if (m.key) headers.authorization = `Bearer ${m.key}`

    ctx.db.prepare('INSERT INTO llm_usage (user_id, day, calls) VALUES (?, ?, 1) ON CONFLICT (user_id, day) DO UPDATE SET calls = calls + 1').run(a.user.id, today())
    let resp
    try {
      // 不跟随重定向；每次连接都检查解析出来的 IP，默认不允许连内网
      resp = await upstreamRequest(m.url, { method: 'POST', headers, body: outBody, timeoutMs: m.timeout_s * 1000, maxBytes: MAX_RESP, allowPrivate: ctx.cfg.allowPrivateLlm })
    } catch (e) {
      const kind = e instanceof UpstreamError ? e.kind : 'network'
      const msg = kind === 'timeout' ? '请求超时了，可以稍后再试' : kind === 'too_large' ? '模型返回的内容太大了' : kind === 'blocked' ? '这个模型的地址不被允许，请联系管理员' : '连不上模型服务，请稍后再试'
      sendJson(r.res, 200, { status: 0, body: msg })
      return
    }
    const respText = resp.text
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
