// 和服务器通信。网页版直接 fetch（登录状态在 HttpOnly Cookie 里，脚本读不到）；
// 桌面版经 Rust 转发（登录令牌存在系统凭据里，同样不交给前端脚本）。
import { invoke, isTauri } from './platform'

/** 单文件界面预览：不连服务器，用内存数据库和模拟 AI */
export const isPreview = __PREVIEW_BUILD__ && typeof window !== 'undefined' && !!(window as unknown as { __FUPAN_PREVIEW__?: string }).__FUPAN_PREVIEW__

export interface User { id: string; username: string; role: 'superadmin' | 'user'; createdAt: number }

export class ApiError extends Error {
  status: number
  code: string
  extra: Record<string, unknown>
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

/** 登录过期时通知界面弹出登录框 */
const expiredSubs = new Set<() => void>()
export function onAuthExpired(f: () => void) { expiredSubs.add(f); return () => { expiredSubs.delete(f) } }

interface RawResp { status: number; text: string | null; bytes: Uint8Array | null; dataVersion: number | null; dataOwner: string | null }
interface CallOpts { json?: unknown; bytes?: Uint8Array; dataVersion?: number; dataOwner?: string }

function toB64(u: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000))
  return btoa(s)
}
function fromB64(s: string): Uint8Array {
  const bin = atob(s)
  const u = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i)
  return u
}

interface TauriResp { status: number; body: string | null; bin: string | null; dataVersion: number | null; dataOwner: string | null }
const fromTauri = (r: TauriResp): RawResp => ({ status: r.status, text: r.body, bytes: r.bin ? fromB64(r.bin) : null, dataVersion: r.dataVersion, dataOwner: r.dataOwner })

async function rawCall(method: string, path: string, o: CallOpts = {}): Promise<RawResp> {
  if (isTauri) {
    return fromTauri(await invoke<TauriResp>('api_call', {
      req: { method, path, json: o.json === undefined ? null : JSON.stringify(o.json), bin: o.bytes ? toB64(o.bytes) : null, dataVersion: o.dataVersion ?? null, dataOwner: o.dataOwner ?? null },
    }))
  }
  const headers: Record<string, string> = { 'X-LoveMemo': '1' }
  let body: BodyInit | undefined
  if (o.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(o.json) }
  if (o.bytes) { headers['Content-Type'] = 'application/octet-stream'; body = o.bytes as unknown as BodyInit }
  if (o.dataVersion !== undefined) headers['X-Data-Version'] = String(o.dataVersion)
  if (o.dataOwner !== undefined) headers['X-Data-Owner'] = o.dataOwner
  let resp: Response
  try {
    resp = await fetch(path, { method, headers, body, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  } catch {
    throw new ApiError(0, 'network', '连不上服务器，请检查网络后再试')
  }
  const dv = resp.headers.get('X-Data-Version')
  const isBin = (resp.headers.get('Content-Type') ?? '').startsWith('application/octet-stream')
  return {
    status: resp.status,
    text: isBin ? null : await resp.text(),
    bytes: isBin ? new Uint8Array(await resp.arrayBuffer()) : null,
    dataVersion: dv === null ? null : Number(dv),
    dataOwner: resp.headers.get('X-Data-Owner'),
  }
}

function check(r: RawResp): RawResp {
  if (r.status >= 200 && r.status < 300) return r
  let j: { error?: string; message?: string } & Record<string, unknown> = {}
  try { j = JSON.parse(r.text ?? '') } catch { /* 非 JSON */ }
  if (r.status === 401 && j.error === 'login_required') expiredSubs.forEach((f) => f())
  throw new ApiError(r.status, j.error ?? 'http_' + r.status, j.message ?? (r.status === 0 ? '连不上服务器，请检查网络后再试' : `服务器返回了错误（${r.status}）`), j)
}

async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
  const r = check(await rawCall(method, path, body === undefined ? {} : { json: body }))
  return (r.text ? JSON.parse(r.text) : {}) as T
}

// ---------- 账号 ----------
export const authState = () => json<{ needsSetup: boolean; user: User | null }>('GET', '/api/auth/state')
export const setup = (setupCode: string, username: string, password: string) => json('POST', '/api/auth/setup', { setupCode, username, password })
export const register = (inviteCode: string, username: string, password: string) => json('POST', '/api/auth/register', { inviteCode, username, password })
export async function login(username: string, password: string): Promise<User> {
  if (isTauri) {
    const r = check(fromTauri(await invoke<TauriResp>('api_login', { username, password })))
    return (JSON.parse(r.text ?? '{}') as { user: User }).user
  }
  return (await json<{ user: User }>('POST', '/api/auth/login', { username, password })).user
}
export async function logout() {
  if (isTauri) { await invoke('api_logout'); return }
  await json('POST', '/api/auth/logout', {})
}
export const changePassword = (current: string, next: string) => json('POST', '/api/account/password', { current, next })
export const logoutAll = async () => { await json('POST', '/api/account/logout-all', {}); if (isTauri) await invoke('api_logout').catch(() => {}) }
export const sessions = () => json<{ sessions: { current: boolean; kind: string; createdAt: number; lastSeen: number; ip: string; ua: string }[] }>('GET', '/api/account/sessions')

// ---------- 桌面版：服务器地址 ----------
export const getServerUrl = () => (isTauri ? invoke<string | null>('server_get_url') : Promise.resolve(location.origin))
/** allowHttp：用户已经确认可以用不加密的 http 地址 */
export const setServerUrl = (url: string, allowHttp = false) => invoke<string>('server_set_url', { url, allowHttp })

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']
/** 不加密的 http 地址（本机调试除外）。没写协议的按 https 算 */
export function isPlainHttpUrl(u: string | null | undefined): boolean {
  const t = u?.trim()
  if (!t) return false
  try {
    const x = new URL(t.includes('://') ? t : `https://${t}`)
    return x.protocol === 'http:' && !LOOPBACK.includes(x.hostname)
  } catch { return false }
}

// ---------- 数据 ----------
export async function dataGet(): Promise<{ version: number; owner: string; bytes: Uint8Array | null }> {
  const r = check(await rawCall('GET', '/api/data'))
  if (!r.dataOwner) throw new ApiError(500, 'bad_response', '服务器返回的内容不完整')
  return { version: r.dataVersion ?? 0, owner: r.dataOwner, bytes: r.status === 204 ? null : r.bytes }
}
export async function dataPut(bytes: Uint8Array, baseVersion: number, owner: string): Promise<number> {
  const r = check(await rawCall('PUT', '/api/data', { bytes, dataVersion: baseVersion, dataOwner: owner }))
  return (JSON.parse(r.text ?? '{}') as { version: number }).version
}

// ---------- AI ----------
export interface ServerModel {
  id: string; name: string; protocol: 'openai' | 'anthropic'; model: string; supports_vision: boolean; supports_json: boolean
  temperature: number | null; max_tokens: number; timeout_s: number; quirks: Record<string, boolean>; price_in: number | null; price_out: number | null
  routes: ('recognize' | 'analyze' | 'quiz' | 'roleplay')[]
}
export const models = () => json<{ models: ServerModel[]; dailyLimit: number }>('GET', '/api/models')
export const llm = (profileId: string, body: Record<string, unknown>) => json<{ status: number; body: string }>('POST', '/api/llm', { profileId, body })

// ---------- 管理 ----------
export interface Invite { id: string; note: string; maxUses: number; uses: number; expiresAt: number; createdAt: number; revokedAt: number | null; status: 'active' | 'used' | 'expired' | 'revoked'; usedBy: { username: string; at: number }[] }
export interface AdminUser { id: string; username: string; role: string; disabled: boolean; createdAt: number; lastLoginAt: number | null; dataSize: number; sessions: number; callsToday: number; callsTotal: number }
export interface AuditEvent { at: number; username: string; event: string; ip: string; detail: string }
export const admin = {
  invites: () => json<{ invites: Invite[] }>('GET', '/api/admin/invites'),
  createInvite: (maxUses: number, expiresHours: number, note: string) => json<{ id: string; code: string; expiresAt: number }>('POST', '/api/admin/invites', { maxUses, expiresHours, note }),
  revokeInvite: (id: string) => json('POST', `/api/admin/invites/${encodeURIComponent(id)}/revoke`, {}),
  users: () => json<{ users: AdminUser[] }>('GET', '/api/admin/users'),
  setDisabled: (id: string, disabled: boolean) => json('POST', `/api/admin/users/${encodeURIComponent(id)}/${disabled ? 'disable' : 'enable'}`, {}),
  deleteUser: (id: string, password: string) => json('POST', `/api/admin/users/${encodeURIComponent(id)}/delete`, { password }),
  audit: () => json<{ events: AuditEvent[] }>('GET', '/api/admin/audit'),
}

// ---------- 管理：AI 服务商和模型 ----------
export type RouteKey = 'recognize' | 'analyze' | 'quiz' | 'roleplay'
export interface AdminModel { id: string; model: string; name: string; enabled: boolean; supports_vision: boolean; supports_json: boolean; max_tokens: number; timeout_s: number; price_in: number | null; price_out: number | null; routes: RouteKey[] }
export interface AdminProvider { id: string; name: string; protocol: 'openai' | 'anthropic'; base_url: string; enabled: boolean; hasKey: boolean; keyHint: string; models: AdminModel[] }
export interface ProbeModel { id: string; name: string }
export const llmAdmin = {
  list: () => json<{ allowPrivate: boolean; providers: AdminProvider[] }>('GET', '/api/admin/llm'),
  probe: (o: { protocol: string; base_url: string; api_key?: string; providerId?: string }) => json<{ models: ProbeModel[] }>('POST', '/api/admin/llm/probe', o),
  create: (o: { name: string; protocol: string; base_url: string; api_key: string; models: { model: string; name: string }[]; password: string }) => json<{ id: string; added: number }>('POST', '/api/admin/llm/providers', o),
  update: (id: string, o: { name?: string; enabled?: boolean; protocol?: string; base_url?: string; api_key?: string; clear_key?: boolean; password?: string }) => json('POST', `/api/admin/llm/providers/${encodeURIComponent(id)}/update`, o),
  remove: (id: string) => json('POST', `/api/admin/llm/providers/${encodeURIComponent(id)}/delete`, {}),
  addModels: (id: string, models: { model: string; name: string }[]) => json<{ added: number }>('POST', `/api/admin/llm/providers/${encodeURIComponent(id)}/models`, { models }),
  updateModel: (id: string, o: Partial<Omit<AdminModel, 'id' | 'model'>>) => json('POST', `/api/admin/llm/models/${encodeURIComponent(id)}/update`, o),
  removeModel: (id: string) => json('POST', `/api/admin/llm/models/${encodeURIComponent(id)}/delete`, {}),
}
