// AI 服务商和模型：超级管理员在管理页填端点地址和 API Key → 获取模型列表 → 多选添加 → 开启。
// API Key 加密后存进数据库，任何接口都不返回明文；改端点地址或 Key 要再输一次管理员密码，
// 并且改了地址必须重新填 Key（防止被盗的管理员会话把已存的 Key 发到别的地址）。
import { randomUUID } from 'node:crypto'
import type { Ctx, Req } from './context.ts'
import { audit, tx } from './db.ts'
import { decrypt, encrypt } from './crypto.ts'
import { HttpError, readJson, sendJson } from './http.ts'
import { reauth, requireAdmin } from './auth.ts'
import { UpstreamError, checkResolves, checkUrl, upstreamRequest } from './upstream.ts'

export type Protocol = 'openai' | 'anthropic'
export type Route = 'recognize' | 'analyze' | 'quiz' | 'roleplay'
const ROUTES: Route[] = ['recognize', 'analyze', 'quiz', 'roleplay']
const QUIRKS = ['noTemperature', 'maxCompletionTokens', 'noResponseFormat'] as const
type Quirks = Partial<Record<(typeof QUIRKS)[number], boolean>>

/** 转发时用到的完整信息（含解密后的 Key），只在服务端内部使用 */
export interface ServerModel {
  id: string
  name: string
  protocol: Protocol
  url: string
  model: string
  key: string | null
  supports_vision: boolean
  supports_json: boolean
  temperature: number | null
  max_tokens: number
  timeout_s: number
  quirks: Quirks
  price_in: number | null
  price_out: number | null
  routes: Route[]
}

interface ProviderRow { id: string; name: string; protocol: Protocol; base_url: string; key_enc: Uint8Array | null; key_hint: string; enabled: number; created_at: number; updated_at: number }
interface ModelRow { id: string; provider_id: string; model: string; name: string; enabled: number; supports_vision: number; supports_json: number; max_tokens: number; timeout_s: number; temperature: number | null; quirks: string; price_in: number | null; price_out: number | null; routes: string; created_at: number }

// ---------- 地址 ----------
export function chatUrl(protocol: Protocol, base: string): string {
  const b = base.replace(/\/+$/, '')
  if (protocol === 'anthropic') return /\/messages$/.test(b) ? b : /\/v1$/.test(b) ? b + '/messages' : b + '/v1/messages'
  return /\/chat\/completions$/.test(b) ? b : b + '/chat/completions'
}
function modelsUrl(protocol: Protocol, base: string): string {
  if (protocol === 'anthropic') {
    const b = base.replace(/\/+$/, '').replace(/\/messages$/, '')
    return /\/v1$/.test(b) ? b + '/models' : b + '/v1/models'
  }
  return base.replace(/\/+$/, '').replace(/\/chat\/completions$/, '') + '/models'
}
function authHeaders(protocol: Protocol, key: string | null): Record<string, string> {
  if (protocol === 'anthropic') return { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) }
  return key ? { authorization: `Bearer ${key}` } : {}
}

function badField(msg: string): never { throw new HttpError(400, 'bad_field', msg) }

function parseProtocol(v: unknown): Protocol {
  if (v === 'openai' || v === 'anthropic') return v
  badField('接口协议只能是 OpenAI 兼容或 Anthropic')
}
function parseBaseUrl(ctx: Ctx, v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 300) badField('请填写端点地址')
  let u: URL
  try { u = checkUrl(v.trim(), ctx.cfg.allowPrivateLlm) } catch (e) {
    const msg = e instanceof UpstreamError ? e.message : '端点地址格式不对'
    badField(e instanceof UpstreamError && !ctx.cfg.allowPrivateLlm && /https|内网/.test(msg)
      ? `${msg}。如果要用本机或内网的模型（比如 Ollama），需要在服务器上设置 ALLOW_PRIVATE_LLM_HOSTS=1` : msg)
  }
  if (u.search || u.hash) badField('端点地址里不要带 ? 或 # 后面的内容')
  return (u.origin + u.pathname).replace(/\/+$/, '')
}
function parseKey(v: unknown): string {
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string' || v.length > 500) badField('API Key 格式不对')
  const k = v.trim()
  if (/[\s\u0000-\u001f]/.test(k)) badField('API Key 里不能有空格或换行')
  return k
}
function parseName(v: unknown, fallback: string, max = 40): string {
  const s = typeof v === 'string' ? v.trim() : ''
  return (s || fallback).slice(0, max)
}
function isModelId(s: unknown): s is string {
  return typeof s === 'string' && s.length >= 1 && s.length <= 200 && !/[\u0000-\u001f\u007f]/.test(s)
}

// ---------- Key 加解密 ----------
function sealKey(ctx: Ctx, providerId: string, key: string): { enc: Buffer | null; hint: string } {
  if (!key) return { enc: null, hint: '' }
  return { enc: encrypt(ctx.providerKey, Buffer.from(key, 'utf8'), `provider:${providerId}`), hint: key.length > 8 ? key.slice(-4) : '' }
}
function openKey(ctx: Ctx, p: ProviderRow): string | null {
  if (!p.key_enc) return null
  return decrypt(ctx.providerKey, Buffer.from(p.key_enc), `provider:${p.id}`).toString('utf8')
}

// ---------- 获取模型列表 ----------
function upstreamFail(e: unknown): never {
  if (e instanceof HttpError) throw e
  if (e instanceof UpstreamError) {
    const hint = e.kind === 'blocked' ? '。如果要用本机或内网的模型，需要在服务器上设置 ALLOW_PRIVATE_LLM_HOSTS=1' : ''
    throw new HttpError(400, 'upstream_' + e.kind, e.message + hint)
  }
  throw new HttpError(502, 'upstream_error', '连不上这个地址')
}

function statusError(status: number, text: string): never {
  let msg = text.slice(0, 200)
  try { const j = JSON.parse(text); msg = String(j.error?.message ?? j.message ?? j.error ?? msg).slice(0, 200) } catch { /* 原样 */ }
  if (status === 401 || status === 403) throw new HttpError(400, 'upstream_auth', `API Key 不对或没有权限（${status}）`)
  if (status === 404) throw new HttpError(400, 'upstream_404', '这个端点没有模型列表接口（404）。请检查地址，或者在下面手动填写模型名')
  throw new HttpError(400, 'upstream_status', `服务商返回了错误（${status}）：${msg}`)
}

async function fetchModelList(ctx: Ctx, protocol: Protocol, base: string, key: string | null): Promise<{ id: string; name: string }[]> {
  const out = new Map<string, string>()
  let url = modelsUrl(protocol, base) + (protocol === 'anthropic' ? '?limit=1000' : '')
  for (let page = 0; page < 5; page++) {
    let r
    try {
      r = await upstreamRequest(url, { method: 'GET', headers: authHeaders(protocol, key), timeoutMs: 20_000, maxBytes: 5 * 1024 * 1024, allowPrivate: ctx.cfg.allowPrivateLlm })
    } catch (e) { upstreamFail(e) }
    if (r.status < 200 || r.status >= 300) statusError(r.status, r.text)
    let j: { data?: unknown; models?: unknown; has_more?: unknown; last_id?: unknown }
    try { j = JSON.parse(r.text) } catch { throw new HttpError(400, 'upstream_format', '返回的内容不是模型列表，请检查端点地址') }
    const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : null
    if (!list) throw new HttpError(400, 'upstream_format', '返回的内容不是模型列表，请检查端点地址')
    for (const m of list as Record<string, unknown>[]) {
      const id = m?.id ?? m?.name ?? m?.model
      if (isModelId(id) && !out.has(id) && out.size < 3000) {
        const dn = m?.display_name
        out.set(id, typeof dn === 'string' && dn.trim() ? dn.trim().slice(0, 40) : id.slice(0, 40))
      }
    }
    if (protocol === 'anthropic' && j.has_more === true && typeof j.last_id === 'string') {
      url = modelsUrl(protocol, base) + '?limit=1000&after_id=' + encodeURIComponent(j.last_id)
    } else break
  }
  return [...out].map(([id, name]) => ({ id, name })).sort((a, b) => a.id.localeCompare(b.id))
}

// ---------- 给前端、给转发用的查询 ----------
function getProvider(ctx: Ctx, id: string): ProviderRow {
  const p = ctx.db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(id) as ProviderRow | undefined
  if (!p) throw new HttpError(404, 'not_found', '找不到这个服务商')
  return p
}

function toServerModel(ctx: Ctx, m: ModelRow, p: ProviderRow): ServerModel {
  let quirks: Quirks = {}
  try { const q = JSON.parse(m.quirks); for (const k of QUIRKS) if (q?.[k] === true) quirks[k] = true } catch { quirks = {} }
  let routes: Route[] = []
  try { const r = JSON.parse(m.routes); routes = ROUTES.filter((x) => Array.isArray(r) && r.includes(x)) } catch { routes = [] }
  return {
    id: m.id, name: m.name, protocol: p.protocol, url: chatUrl(p.protocol, p.base_url), model: m.model, key: null,
    supports_vision: !!m.supports_vision, supports_json: !!m.supports_json, temperature: m.temperature, max_tokens: m.max_tokens,
    timeout_s: m.timeout_s, quirks, price_in: m.price_in, price_out: m.price_out, routes,
  }
}

/** 已开启的模型（服务商和模型都开启） */
export function usableModels(ctx: Ctx): ServerModel[] {
  const rows = ctx.db.prepare(`SELECT m.*, p.id AS p_id FROM llm_models m JOIN llm_providers p ON p.id = m.provider_id
    WHERE m.enabled = 1 AND p.enabled = 1 ORDER BY p.created_at, m.created_at`).all() as unknown as (ModelRow & { p_id: string })[]
  const providers = new Map<string, ProviderRow>()
  return rows.map((m) => {
    if (!providers.has(m.p_id)) providers.set(m.p_id, getProvider(ctx, m.p_id))
    return toServerModel(ctx, m, providers.get(m.p_id)!)
  })
}

/** 转发用：带解密后的 Key */
export function usableModel(ctx: Ctx, id: string): ServerModel | null {
  const m = ctx.db.prepare('SELECT * FROM llm_models WHERE id = ? AND enabled = 1').get(id) as ModelRow | undefined
  if (!m) return null
  const p = ctx.db.prepare('SELECT * FROM llm_providers WHERE id = ? AND enabled = 1').get(m.provider_id) as ProviderRow | undefined
  if (!p) return null
  return { ...toServerModel(ctx, m, p), key: openKey(ctx, p) }
}

// ---------- 管理接口 ----------
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function publicModel(m: ModelRow) {
  let routes: Route[] = []
  try { routes = ROUTES.filter((x) => (JSON.parse(m.routes) as unknown[]).includes(x)) } catch { routes = [] }
  return {
    id: m.id, model: m.model, name: m.name, enabled: !!m.enabled, supports_vision: !!m.supports_vision, supports_json: !!m.supports_json,
    max_tokens: m.max_tokens, timeout_s: m.timeout_s, price_in: m.price_in, price_out: m.price_out, routes,
  }
}

export async function adminList(ctx: Ctx, r: Req) {
  requireAdmin(r)
  const ps = ctx.db.prepare('SELECT * FROM llm_providers ORDER BY created_at').all() as unknown as ProviderRow[]
  const ms = ctx.db.prepare('SELECT * FROM llm_models ORDER BY created_at').all() as unknown as ModelRow[]
  sendJson(r.res, 200, {
    allowPrivate: ctx.cfg.allowPrivateLlm,
    providers: ps.map((p) => ({
      id: p.id, name: p.name, protocol: p.protocol, base_url: p.base_url, enabled: !!p.enabled,
      hasKey: !!p.key_enc, keyHint: p.key_hint, models: ms.filter((m) => m.provider_id === p.id).map(publicModel),
    })),
  })
}

/**
 * 获取模型列表（不保存任何东西）。
 * 带 providerId 时可以不填 Key，用已保存的 Key——但只在地址没改的情况下，改了地址必须重新填 Key。
 */
export async function adminProbe(ctx: Ctx, r: Req) {
  const a = requireAdmin(r)
  const rl = ctx.limits.adminProbe.hit(a.user.id)
  if (!rl.ok) throw new HttpError(429, 'rate_limited', '获取得太频繁了，请稍后再试', { retryAfter: rl.retryAfter })
  const body = await readJson(r.req)
  const protocol = parseProtocol(body.protocol)
  const base = parseBaseUrl(ctx, body.base_url)
  let key = parseKey(body.api_key)
  if (!key && typeof body.providerId === 'string' && UUID.test(body.providerId)) {
    const p = getProvider(ctx, body.providerId)
    if (p.base_url !== base || p.protocol !== protocol) {
      if (p.key_enc) throw new HttpError(400, 'key_required', '端点地址改了，请重新填写 API Key')
    } else key = openKey(ctx, p) ?? ''
  }
  audit(ctx.db, 'llm_probe', { userId: a.user.id, username: a.user.username, ip: r.ip, detail: new URL(base).host })
  const models = await fetchModelList(ctx, protocol, base, key || null)
  sendJson(r.res, 200, { models })
}

interface NewModel { model: string; name: string }
function parseNewModels(v: unknown): NewModel[] {
  if (v === undefined) return []
  if (!Array.isArray(v) || v.length > 500) badField('模型列表格式不对')
  const out = new Map<string, NewModel>()
  for (const x of v as unknown[]) {
    const model = typeof x === 'string' ? x.trim() : typeof x === 'object' && x ? String((x as Record<string, unknown>).model ?? '').trim() : ''
    if (!isModelId(model)) badField('模型名格式不对')
    const name = typeof x === 'object' && x ? parseName((x as Record<string, unknown>).name, model) : model.slice(0, 40)
    out.set(model, { model, name })
  }
  return [...out.values()]
}

function guessVision(protocol: Protocol, model: string): boolean {
  if (protocol === 'anthropic') return true
  return /(^|[-_/:])(vl|vision)([-_.:]|$)|gpt-4o|gpt-4\.1|gpt-5|gemini|claude|-4v|omni/i.test(model)
}

function insertModels(ctx: Ctx, providerId: string, protocol: Protocol, list: NewModel[]): number {
  const st = ctx.db.prepare(`INSERT OR IGNORE INTO llm_models (id, provider_id, model, name, enabled, supports_vision, supports_json, max_tokens, timeout_s, created_at)
    VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?, ?)`)
  let n = 0
  const now = Date.now()
  list.forEach((m, i) => {
    n += Number(st.run(randomUUID(), providerId, m.model, m.name, guessVision(protocol, m.model) ? 1 : 0, protocol === 'anthropic' ? 16000 : 8192, protocol === 'anthropic' ? 180 : 120, now + i).changes)
  })
  return n
}

/** 新建服务商，可以同时添加选中的模型。要输管理员密码 */
export async function adminCreate(ctx: Ctx, r: Req) {
  const a = requireAdmin(r)
  const body = await readJson(r.req, 256 * 1024)
  const protocol = parseProtocol(body.protocol)
  const base = parseBaseUrl(ctx, body.base_url)
  const key = parseKey(body.api_key)
  const name = parseName(body.name, new URL(base).hostname)
  const models = parseNewModels(body.models)
  try { await checkResolves(new URL(base), ctx.cfg.allowPrivateLlm) } catch (e) { upstreamFail(e) }
  await reauth(ctx, r, a, typeof body.password === 'string' ? body.password.slice(0, 512) : '', 'llm_reauth_fail')
  if ((ctx.db.prepare('SELECT COUNT(*) AS n FROM llm_providers').get() as { n: number }).n >= 50) badField('服务商最多 50 个')
  const id = randomUUID()
  const sealed = sealKey(ctx, id, key)
  const now = Date.now()
  let added = 0
  tx(ctx.db, () => {
    ctx.db.prepare('INSERT INTO llm_providers (id, name, protocol, base_url, key_enc, key_hint, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)')
      .run(id, name, protocol, base, sealed.enc, sealed.hint, now, now)
    added = insertModels(ctx, id, protocol, models)
    audit(ctx.db, 'llm_provider_created', { userId: a.user.id, username: a.user.username, ip: r.ip, detail: `${name} ${new URL(base).host} models=${added}` })
  })
  sendJson(r.res, 201, { id, added })
}

/** 修改服务商。改地址或 Key 要输管理员密码；改了地址必须同时填新 Key（原来有 Key 的话） */
export async function adminUpdate(ctx: Ctx, r: Req, id: string) {
  const a = requireAdmin(r)
  const p = getProvider(ctx, id)
  const body = await readJson(r.req)
  const patch: Record<string, string | number | Buffer | null> = {}
  if (body.name !== undefined) patch.name = parseName(body.name, p.name)
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') badField('enabled 格式不对')
    patch.enabled = body.enabled ? 1 : 0
  }
  const protocol = body.protocol !== undefined ? parseProtocol(body.protocol) : p.protocol
  const base = body.base_url !== undefined ? parseBaseUrl(ctx, body.base_url) : p.base_url
  const key = parseKey(body.api_key)
  const urlChanged = base !== p.base_url || protocol !== p.protocol
  if (urlChanged) { try { await checkResolves(new URL(base), ctx.cfg.allowPrivateLlm) } catch (e) { upstreamFail(e) } }
  if (urlChanged || key || body.clear_key === true) {
    await reauth(ctx, r, a, typeof body.password === 'string' ? body.password.slice(0, 512) : '', 'llm_reauth_fail')
    if (urlChanged && p.key_enc && !key && body.clear_key !== true) throw new HttpError(400, 'key_required', '端点地址改了，请重新填写 API Key')
    patch.protocol = protocol
    patch.base_url = base
    if (key) { const s = sealKey(ctx, p.id, key); patch.key_enc = s.enc; patch.key_hint = s.hint }
    else if (body.clear_key === true) { patch.key_enc = null; patch.key_hint = '' }
  }
  const keys = Object.keys(patch)
  if (keys.length) {
    // 列名都来自上面固定的几个，不来自用户输入
    ctx.db.prepare(`UPDATE llm_providers SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => patch[k]), Date.now(), p.id)
    audit(ctx.db, 'llm_provider_updated', { userId: a.user.id, username: a.user.username, ip: r.ip, detail: `${p.name} ${keys.filter((k) => k !== 'key_hint').join(',')}` })
  }
  sendJson(r.res, 200, { ok: true })
}

export async function adminDelete(ctx: Ctx, r: Req, id: string) {
  const a = requireAdmin(r)
  const p = getProvider(ctx, id)
  ctx.db.prepare('DELETE FROM llm_providers WHERE id = ?').run(p.id)
  audit(ctx.db, 'llm_provider_deleted', { userId: a.user.id, username: a.user.username, ip: r.ip, detail: p.name })
  sendJson(r.res, 200, { ok: true })
}

export async function adminAddModels(ctx: Ctx, r: Req, id: string) {
  const a = requireAdmin(r)
  const p = getProvider(ctx, id)
  const body = await readJson(r.req, 256 * 1024)
  const models = parseNewModels(body.models)
  if (!models.length) badField('请至少选一个模型')
  const added = insertModels(ctx, p.id, p.protocol, models)
  audit(ctx.db, 'llm_models_added', { userId: a.user.id, username: a.user.username, ip: r.ip, detail: `${p.name} +${added}` })
  sendJson(r.res, 200, { added })
}

export async function adminUpdateModel(ctx: Ctx, r: Req, id: string) {
  const a = requireAdmin(r)
  const m = ctx.db.prepare('SELECT * FROM llm_models WHERE id = ?').get(id) as ModelRow | undefined
  if (!m) throw new HttpError(404, 'not_found', '找不到这个模型')
  const b = await readJson(r.req)
  const patch: Record<string, string | number | null> = {}
  const bool = (k: string) => { if (b[k] !== undefined) { if (typeof b[k] !== 'boolean') badField(`${k} 格式不对`); patch[k] = b[k] ? 1 : 0 } }
  const int = (k: string, lo: number, hi: number) => { if (b[k] !== undefined) { const v = b[k]; if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) badField(`${k} 要在 ${lo}~${hi} 之间`); patch[k] = v } }
  const price = (k: string) => { if (b[k] !== undefined) { const v = b[k]; if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100000)) badField('价格格式不对'); patch[k] = v as number | null } }
  if (b.name !== undefined) patch.name = parseName(b.name, m.model)
  bool('enabled'); bool('supports_vision'); bool('supports_json')
  int('max_tokens', 256, 200000); int('timeout_s', 10, 600)
  price('price_in'); price('price_out')
  if (b.routes !== undefined) {
    if (!Array.isArray(b.routes)) badField('推荐用途格式不对')
    patch.routes = JSON.stringify(ROUTES.filter((x) => (b.routes as unknown[]).includes(x)))
  }
  const keys = Object.keys(patch)
  if (keys.length) {
    ctx.db.prepare(`UPDATE llm_models SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => patch[k]), m.id)
    audit(ctx.db, 'llm_model_updated', { userId: a.user.id, username: a.user.username, ip: r.ip, detail: `${m.model} ${keys.join(',')}` })
  }
  sendJson(r.res, 200, { ok: true })
}

export async function adminDeleteModel(ctx: Ctx, r: Req, id: string) {
  const a = requireAdmin(r)
  const m = ctx.db.prepare('SELECT model FROM llm_models WHERE id = ?').get(id) as { model: string } | undefined
  if (!m) throw new HttpError(404, 'not_found', '找不到这个模型')
  ctx.db.prepare('DELETE FROM llm_models WHERE id = ?').run(id)
  audit(ctx.db, 'llm_model_deleted', { userId: a.user.id, username: a.user.username, ip: r.ip, detail: m.model })
  sendJson(r.res, 200, { ok: true })
}
