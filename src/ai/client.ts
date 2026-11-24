// 大模型调用：OpenAI 兼容协议 + Anthropic 原生协议。
// 桌面端请求由 Rust 端发出（读取系统凭据里的 Key，绕开跨域）；浏览器预览走模拟数据。
import type { z } from 'zod'
import type { AiTask, ModelProfile, RouteKey } from '../lib/types'
import { invoke, isTauri } from '../lib/platform'
import { extractJSON } from '../domain/text'
import { getSettings } from '../db/base'
import { getProfile, listProfiles, logCall, saveProfile } from '../db/misc'
import { mockReply } from './mock'

export type Part = { type: 'text'; text: string } | { type: 'image'; dataUrl: string }
export interface ChatMsg { role: 'user' | 'assistant'; content: string | Part[] }
export interface CallOpts { task: AiTask; system: string; messages: ChatMsg[]; json?: boolean; temperature?: number; maxTokens?: number; profileId?: string; mockData?: unknown }

export class AiError extends Error {
  detail: string
  constructor(message: string, detail = '') { super(message); this.detail = detail }
}

const ROUTE: Partial<Record<AiTask, RouteKey>> = { recognize: 'recognize', analyze: 'analyze', match: 'analyze', weekly: 'analyze', quiz: 'quiz', grade: 'quiz', roleplay: 'roleplay' }

export async function profileFor(task: AiTask, explicit?: string): Promise<ModelProfile | null> {
  if (explicit) return getProfile(explicit)
  const s = await getSettings()
  const k = ROUTE[task]
  const id = k ? s.routing[k] : null
  if (id) { const p = await getProfile(id); if (p) return p }
  const all = await listProfiles()
  if (task === 'recognize') return all.find((p) => p.supports_vision) ?? null
  return all[0] ?? null
}

export function endpoint(p: ModelProfile): string {
  const b = p.base_url.trim().replace(/\/+$/, '')
  if (p.protocol === 'anthropic') {
    if (/\/messages$/.test(b)) return b
    return /\/v1$/.test(b) ? b + '/messages' : b + '/v1/messages'
  }
  if (/\/chat\/completions$/.test(b)) return b
  return b + '/chat/completions'
}

function splitDataUrl(u: string) {
  const m = u.match(/^data:([^;]+);base64,(.*)$/)
  return m ? { media: m[1], data: m[2] } : { media: 'image/jpeg', data: u }
}

function buildBody(p: ModelProfile, o: CallOpts): Record<string, unknown> {
  const temp = o.temperature ?? p.temperature
  const maxTok = o.maxTokens ? Math.max(o.maxTokens, p.max_tokens) : p.max_tokens
  if (p.protocol === 'anthropic') {
    const body: Record<string, unknown> = {
      model: p.model, max_tokens: maxTok, system: o.system,
      messages: o.messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? m.content : m.content.map((c) => c.type === 'text'
          ? { type: 'text', text: c.text }
          : { type: 'image', source: { type: 'base64', media_type: splitDataUrl(c.dataUrl).media, data: splitDataUrl(c.dataUrl).data } }),
      })),
    }
    if (temp != null && !p.quirks.noTemperature) body.temperature = temp
    return body
  }
  const body: Record<string, unknown> = {
    model: p.model,
    messages: [{ role: 'system', content: o.system }, ...o.messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : m.content.map((c) => c.type === 'text'
        ? { type: 'text', text: c.text } : { type: 'image_url', image_url: { url: c.dataUrl } }),
    }))],
  }
  if (temp != null && !p.quirks.noTemperature) body.temperature = temp
  body[p.quirks.maxCompletionTokens ? 'max_completion_tokens' : 'max_tokens'] = maxTok
  if (o.json && p.supports_json && !p.quirks.noResponseFormat) body.response_format = { type: 'json_object' }
  return body
}

interface RawResp { status: number; body: string }

async function send(p: ModelProfile, body: Record<string, unknown>): Promise<RawResp> {
  return invoke<RawResp>('llm_request', { req: { profileId: p.id, protocol: p.protocol, url: endpoint(p), body: JSON.stringify(body), timeoutS: p.timeout_s, needsKey: p.needs_key } })
}

/** 400 错误里提到不支持的参数时，自动调整并记住（不同服务、不同模型对参数的要求不一样） */
function adapt(p: ModelProfile, status: number, text: string): ModelProfile | null {
  if (status !== 400 && status !== 422) return null
  const t = text.toLowerCase()
  const q = { ...p.quirks }
  if (t.includes('temperature') && !q.noTemperature) q.noTemperature = true
  else if (t.includes('max_tokens') && t.includes('max_completion_tokens') && !q.maxCompletionTokens) q.maxCompletionTokens = true
  else if (t.includes('response_format') && !q.noResponseFormat) q.noResponseFormat = true
  else return null
  return { ...p, quirks: q }
}

function parseResp(p: ModelProfile, body: string) {
  const j = JSON.parse(body) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  if (p.protocol === 'anthropic') {
    // 回复里可能先有 thinking 块，只取 text 块
    const text = (j.content ?? []).filter((b: { type: string }) => b.type === 'text').map((b: { text: string }) => b.text).join('')
    return { text, tin: j.usage?.input_tokens ?? null, tout: j.usage?.output_tokens ?? null }
  }
  return { text: j.choices?.[0]?.message?.content ?? '', tin: j.usage?.prompt_tokens ?? null, tout: j.usage?.completion_tokens ?? null }
}

function errMessage(status: number, body: string): string {
  let msg = body.slice(0, 300)
  try { const j = JSON.parse(body); msg = j.error?.message ?? j.message ?? msg } catch { /* 原样 */ }
  if (status === 401 || status === 403) return `API Key 无效或没有权限（${status}）：${msg}`
  if (status === 404) return `接口地址或模型名不对（404）：${msg}`
  if (status === 429) return `请求太频繁或额度用完（429）：${msg}`
  if (status === 0) return `网络请求失败：${msg}`
  return `模型服务返回错误（${status}）：${msg}`
}

export async function callText(o: CallOpts): Promise<string> {
  if (!isTauri) {
    await new Promise((r) => setTimeout(r, 500))
    const m = mockReply(o.task, o.mockData, !o.json)
    return typeof m === 'string' ? m : JSON.stringify(m)
  }
  let p = await profileFor(o.task, o.profileId)
  if (!p) throw new AiError('还没有配置模型。请到「设置 → 模型」添加一个。')
  const hasImage = o.messages.some((m) => typeof m.content !== 'string' && m.content.some((c) => c.type === 'image'))
  if (hasImage && !p.supports_vision) throw new AiError(`「${p.name}」没有勾选"支持图片"。截图识别需要视觉模型，请在设置里换一个或勾选。`)
  for (let attempt = 0; attempt < 4; attempt++) {
    const t0 = performance.now()
    let r: RawResp
    try { r = await send(p, buildBody(p, o)) } catch (e) {
      await logCall({ task: o.task, profile_name: p.name, model: p.model, latency_ms: Math.round(performance.now() - t0), ok: false, error: String(e) })
      throw new AiError(`网络请求失败：${String(e)}`)
    }
    const ms = Math.round(performance.now() - t0)
    if (r.status >= 200 && r.status < 300) {
      const out = parseResp(p, r.body)
      await logCall({ task: o.task, profile_name: p.name, model: p.model, input_tokens: out.tin, output_tokens: out.tout, latency_ms: ms, ok: true })
      return out.text
    }
    const next = adapt(p, r.status, r.body)
    if (next) { p = next; await saveProfile(next); continue }
    await logCall({ task: o.task, profile_name: p.name, model: p.model, latency_ms: ms, ok: false, error: r.body })
    throw new AiError(errMessage(r.status, r.body), r.body)
  }
  throw new AiError('模型服务一直拒绝请求参数，请检查设置')
}

/** 要求 JSON 输出并用 zod 校验；不合格时把错误发回模型修复一次 */
export async function callJSON<T>(o: CallOpts, schema: z.ZodType<T>): Promise<T> {
  const raw = await callText({ ...o, json: true })
  const first = tryParse(raw, schema)
  if (first.ok) return first.value
  const fix = await callText({
    ...o, json: true,
    messages: [...o.messages, { role: 'assistant', content: raw }, { role: 'user', content: `上面的输出不符合要求：${first.error}。请只输出修正后的 JSON，不要任何其他文字。` }],
  })
  const second = tryParse(fix, schema)
  if (second.ok) return second.value
  throw new AiError('模型输出的格式不对，重试后仍然不对。可以换个模型再试。', fix.slice(0, 2000))
}

function tryParse<T>(raw: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
  let j: unknown
  try { j = extractJSON(raw) } catch (e) { return { ok: false, error: String((e as Error).message) } }
  const r = schema.safeParse(j)
  if (r.success) return { ok: true, value: r.data }
  return { ok: false, error: r.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('；') }
}

/** 设置页"测试连接"：一次文字请求，勾选了支持图片的再发一张小图 */
export async function testProfile(p: ModelProfile): Promise<{ ok: boolean; ms: number; text: string; vision?: boolean }> {
  const t0 = performance.now()
  const text = await callText({ task: 'test', profileId: p.id, system: '你是连接测试。只回复 JSON。', messages: [{ role: 'user', content: '回复 {"ok":true}' }], json: true, maxTokens: 256 })
  const ms = Math.round(performance.now() - t0)
  let vision: boolean | undefined
  if (p.supports_vision) {
    // 16x16 红色方块
    const red = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGO4IydHEmIY1TCqYfhqAACaMxgQdGu1YAAAAABJRU5ErkJggg=='
    try {
      const v = await callText({ task: 'test', profileId: p.id, system: '只回复一个词。', messages: [{ role: 'user', content: [{ type: 'image', dataUrl: red }, { type: 'text', text: '这张图主要是什么颜色？用中文回答一个字。' }] }], maxTokens: 256 })
      vision = /红|red/i.test(v)
    } catch { vision = false }
  }
  return { ok: true, ms, text: text.slice(0, 200), vision }
}
