// 账号：首次安装、登录、注册（注册码）、会话、修改密码
import { randomUUID } from 'node:crypto'
import type { Ctx, Auth, Req } from './context.ts'
import { audit, tx, type UserRow } from './db.ts'
import { hashPassword, normalizeCode, randomToken, safeEqualHex, sha256Hex, verifyPassword } from './crypto.ts'
import { HttpError, parseCookies, readJson, sendJson, str } from './http.ts'

const MIN = 60_000
const LOCK_AFTER = 5

// ---------- 用户名、密码规则 ----------
export function checkUsername(raw: string): { display: string; norm: string } {
  const display = raw.normalize('NFKC').trim()
  const len = [...display].length
  if (len < 1 || len > 32) throw new HttpError(400, 'bad_username', '用户名要 1~32 个字')
  if (!/^[\p{L}\p{N}_.-]+$/u.test(display)) throw new HttpError(400, 'bad_username', '用户名只能用文字、数字和 _ . -')
  return { display, norm: display.toLowerCase() }
}

const COMMON = new Set(['password', 'password1', 'password123', '1234567890', '12345678910', 'qwertyuiop', '1qaz2wsx3edc', 'iloveyou', 'iloveyou1', 'woaini1314', 'woaini520', '5201314520', '1314520520', 'abc1234567', 'a1234567890', 'qwerty123456', 'admin12345', 'administrator', 'zxcvbnm123', 'aa123456789'])
export function checkPassword(pw: string, usernameNorm: string): void {
  const len = [...pw].length
  if (len < 10) throw new HttpError(400, 'weak_password', '密码至少要 10 位')
  if (len > 128) throw new HttpError(400, 'weak_password', '密码最多 128 位')
  const lower = pw.toLowerCase()
  if (COMMON.has(lower)) throw new HttpError(400, 'weak_password', '这个密码太常见了，换一个吧')
  if (new Set(pw).size < 5) throw new HttpError(400, 'weak_password', '密码里不同的字符太少了，换一个复杂一点的')
  if (usernameNorm.length >= 3 && lower.includes(usernameNorm)) throw new HttpError(400, 'weak_password', '密码里不要包含用户名')
}

// ---------- 会话 ----------
function cookieName(ctx: Ctx) {
  // __Host- 前缀要求 Secure、Path=/、不带 Domain，浏览器保证子域名无法覆盖它
  return ctx.cfg.secureCookies ? '__Host-lm_sid' : 'lm_sid'
}

function setSessionCookie(ctx: Ctx, r: Req, token: string) {
  const parts = [`${cookieName(ctx)}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${ctx.cfg.sessionDays * 86400}`]
  if (ctx.cfg.secureCookies) parts.push('Secure')
  r.res.setHeader('Set-Cookie', parts.join('; '))
}
function clearSessionCookie(ctx: Ctx, r: Req) {
  const parts = [`${cookieName(ctx)}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0']
  if (ctx.cfg.secureCookies) parts.push('Secure')
  r.res.setHeader('Set-Cookie', parts.join('; '))
}

function createSession(ctx: Ctx, r: Req, user: UserRow, kind: 'web' | 'desktop'): string {
  const token = randomToken(32)
  const now = Date.now()
  ctx.db.prepare('INSERT INTO sessions (id_hash, user_id, kind, created_at, last_seen, expires_at, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(sha256Hex(token), user.id, kind, now, now, now + ctx.cfg.sessionDays * 86400_000, r.ip.slice(0, 64), String(r.req.headers['user-agent'] ?? '').slice(0, 200))
  // 每人最多保留 20 个会话，多出来的把最久没用的踢掉
  ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash NOT IN (SELECT id_hash FROM sessions WHERE user_id = ? ORDER BY last_seen DESC LIMIT 20)').run(user.id, user.id)
  return token
}

/** 网页用 HttpOnly Cookie，桌面端用 Authorization: Bearer（令牌存在系统凭据里，前端脚本拿不到） */
export function authenticate(ctx: Ctx, r: Req): Auth | null {
  let token: string | undefined
  let kind: 'web' | 'desktop'
  const authz = r.req.headers.authorization
  if (authz !== undefined) {
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authz)
    if (!m) return null
    token = m[1]
    kind = 'desktop'
  } else {
    token = parseCookies(r.req.headers.cookie).get(cookieName(ctx))
    kind = 'web'
  }
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null
  const h = sha256Hex(token)
  const s = ctx.db.prepare('SELECT * FROM sessions WHERE id_hash = ?').get(h) as { user_id: string; kind: string; expires_at: number; last_seen: number } | undefined
  if (!s || s.kind !== kind) return null
  const now = Date.now()
  if (s.expires_at < now || s.last_seen < now - ctx.cfg.sessionIdleDays * 86400_000) {
    ctx.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(h)
    return null
  }
  const user = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) as UserRow | undefined
  if (!user || user.disabled) return null
  if (now - s.last_seen > MIN) ctx.db.prepare('UPDATE sessions SET last_seen = ? WHERE id_hash = ?').run(now, h)
  return { user, sessionHash: h, kind }
}

export function requireUser(r: Req): Auth {
  if (!r.auth) throw new HttpError(401, 'login_required', '请先登录')
  return r.auth
}
export function requireAdmin(r: Req): Auth {
  const a = requireUser(r)
  if (a.user.role !== 'superadmin') throw new HttpError(403, 'forbidden', '只有管理员可以这样做')
  return a
}

export function publicUser(u: UserRow) {
  return { id: u.id, username: u.username, role: u.role, createdAt: u.created_at }
}

function limit(rl: { hit(k: string): { ok: true } | { ok: false; retryAfter: number } }, key: string, msg = '试得太频繁了，请稍后再试') {
  const h = rl.hit(key)
  if (!h.ok) throw new HttpError(429, 'rate_limited', msg, { retryAfter: h.retryAfter })
}

// ---------- 按用户名的失败锁定：连续 5 次错误后锁 15 分钟，之后每次翻倍，最长 24 小时 ----------
// 不存在的用户名也一样记录和锁定，攻击者无法据此判断用户名是否存在
function lockedFor(ctx: Ctx, key: string): number {
  const row = ctx.db.prepare('SELECT locked_until FROM login_throttle WHERE key = ?').get(key) as { locked_until: number } | undefined
  const left = (row?.locked_until ?? 0) - Date.now()
  return left > 0 ? Math.ceil(left / 1000) : 0
}
function recordFail(ctx: Ctx, key: string, threshold: number, exponential: boolean) {
  const now = Date.now()
  const row = ctx.db.prepare('SELECT fails FROM login_throttle WHERE key = ?').get(key) as { fails: number } | undefined
  let fails = (row?.fails ?? 0) + 1
  let lock = 0
  if (fails >= threshold) {
    lock = now + (exponential ? Math.min(15 * MIN * 2 ** (fails - threshold), 24 * 60 * MIN) : 15 * MIN)
    if (!exponential) fails = 0
  }
  ctx.db.prepare('INSERT OR REPLACE INTO login_throttle (key, fails, locked_until, updated_at) VALUES (?, ?, ?, ?)').run(key, fails, lock, now)
}
/**
 * 两层锁：
 * - 同一 IP 对同一账号连续错 5 次，锁这个 IP 15 分钟，之后每次翻倍（最长 24 小时）
 * - 同一账号从所有 IP 累计错 30 次，整个账号锁 15 分钟（防止换 IP 分布式猜密码）
 * 这样单个攻击者只能锁住自己，没法轻易把管理员锁在门外。
 */
function throttleKeys(norm: string, ip: string) {
  return { pair: `p:${norm}|${ip}`, global: `g:${norm}` }
}
function loginLocked(ctx: Ctx, norm: string, ip: string): number {
  const k = throttleKeys(norm, ip)
  return Math.max(lockedFor(ctx, k.pair), lockedFor(ctx, k.global))
}
function loginFailed(ctx: Ctx, norm: string, ip: string) {
  const k = throttleKeys(norm, ip)
  recordFail(ctx, k.pair, LOCK_AFTER, true)
  recordFail(ctx, k.global, 30, false)
}
function clearFails(ctx: Ctx, key: string) {
  ctx.db.prepare('DELETE FROM login_throttle WHERE key = ?').run(key)
}
function lockedError(sec: number) {
  return new HttpError(429, 'locked', `密码错误次数太多，这个账号暂时锁定了，请 ${Math.ceil(sec / 60)} 分钟后再试`, { retryAfter: sec })
}

export function userCount(ctx: Ctx): number {
  return (ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
}

// ---------- 路由 ----------
export async function state(ctx: Ctx, r: Req) {
  sendJson(r.res, 200, { needsSetup: userCount(ctx) === 0, user: r.auth ? publicUser(r.auth.user) : null })
}

/** 首次安装：创建唯一的超级管理员。需要服务器启动日志里打印的一次性安装码，防止别人抢先注册 */
export async function setup(ctx: Ctx, r: Req) {
  limit(ctx.limits.setupIp, r.ip)
  if (userCount(ctx) > 0 || !ctx.setup.codeHash) throw new HttpError(409, 'already_setup', '已经初始化过了，请直接登录')
  const body = await readJson(r.req)
  const code = normalizeCode(str(body, 'setupCode', 64))
  if (!safeEqualHex(sha256Hex(code), ctx.setup.codeHash)) {
    audit(ctx.db, 'setup_fail', { ip: r.ip })
    throw new HttpError(403, 'bad_setup_code', '安装码不对。请在服务器日志里查看（docker compose logs app）')
  }
  const { display, norm } = checkUsername(str(body, 'username', 64))
  const password = str(body, 'password', 512)
  checkPassword(password, norm)
  const hash = await hashPassword(password, ctx.cfg.scryptLogN)
  const id = randomUUID()
  tx(ctx.db, () => {
    // 哈希是异步的：写入前在事务里再确认一次，避免两个请求同时通过检查
    if (userCount(ctx) > 0 || !ctx.setup.codeHash) throw new HttpError(409, 'already_setup', '已经初始化过了，请直接登录')
    const now = Date.now()
    ctx.db.prepare('INSERT INTO users (id, username, username_norm, role, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, display, norm, 'superadmin', hash, now, now)
    ctx.setup.codeHash = null
    audit(ctx.db, 'setup_ok', { userId: id, username: display, ip: r.ip })
  })
  sendJson(r.res, 201, { ok: true })
}

export async function login(ctx: Ctx, r: Req) {
  limit(ctx.limits.authIp, r.ip)
  const body = await readJson(r.req)
  const usernameRaw = str(body, 'username', 64)
  const password = str(body, 'password', 512)
  const kind = body.client === 'desktop' ? 'desktop' : 'web'
  const norm = usernameRaw.normalize('NFKC').trim().toLowerCase()
  // 锁定期间根本不校验密码，猜对了也没用
  const locked = loginLocked(ctx, norm, r.ip)
  if (locked) { audit(ctx.db, 'login_locked', { username: norm, ip: r.ip }); throw lockedError(locked) }

  const user = ctx.db.prepare('SELECT * FROM users WHERE username_norm = ?').get(norm) as UserRow | undefined
  const ok = await verifyPassword(password, user?.password_hash ?? ctx.dummyHash)
  if (!user || !ok) {
    loginFailed(ctx, norm, r.ip)
    audit(ctx.db, 'login_fail', { userId: user?.id, username: norm, ip: r.ip })
    const l = loginLocked(ctx, norm, r.ip)
    if (l) throw lockedError(l)
    throw new HttpError(401, 'bad_credentials', '用户名或密码不对')
  }
  if (user.disabled) {
    audit(ctx.db, 'login_disabled', { userId: user.id, username: user.username, ip: r.ip })
    throw new HttpError(403, 'disabled', '这个账号已被管理员停用')
  }
  clearFails(ctx, throttleKeys(norm, r.ip).pair)
  const token = createSession(ctx, r, user, kind)
  ctx.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Date.now(), user.id)
  audit(ctx.db, 'login_ok', { userId: user.id, username: user.username, ip: r.ip, detail: kind })
  if (kind === 'web') { setSessionCookie(ctx, r, token); sendJson(r.res, 200, { user: publicUser(user) }) }
  else sendJson(r.res, 200, { user: publicUser(user), token })
}

export async function logout(ctx: Ctx, r: Req) {
  if (r.auth) {
    ctx.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(r.auth.sessionHash)
    audit(ctx.db, 'logout', { userId: r.auth.user.id, username: r.auth.user.username, ip: r.ip })
  }
  clearSessionCookie(ctx, r)
  sendJson(r.res, 200, { ok: true })
}

interface InviteRow { id: string; max_uses: number; uses: number; expires_at: number; revoked_at: number | null }
function usableInvite(ctx: Ctx, codeHash: string): InviteRow | null {
  const inv = ctx.db.prepare('SELECT id, max_uses, uses, expires_at, revoked_at FROM invites WHERE code_hash = ?').get(codeHash) as InviteRow | undefined
  if (!inv || inv.revoked_at || inv.expires_at < Date.now() || inv.uses >= inv.max_uses) return null
  return inv
}

/** 注册：必须有管理员发的注册码。注册码 125 位随机数，库里只存 SHA-256 */
export async function register(ctx: Ctx, r: Req) {
  limit(ctx.limits.authIp, r.ip)
  limit(ctx.limits.registerIp, r.ip, '注册太频繁了，请过一会儿再试')
  if (userCount(ctx) === 0) throw new HttpError(409, 'needs_setup', '还没有初始化，请先创建管理员')
  const body = await readJson(r.req)
  const code = normalizeCode(str(body, 'inviteCode', 64))
  const { display, norm } = checkUsername(str(body, 'username', 64))
  const password = str(body, 'password', 512)
  checkPassword(password, norm)

  const codeHash = sha256Hex(code)
  if (!/^[0-9A-Z]{25}$/.test(code) || !usableInvite(ctx, codeHash)) {
    limit(ctx.limits.inviteFailIp, r.ip, '注册码错误次数太多，请一小时后再试')
    audit(ctx.db, 'register_bad_invite', { username: display, ip: r.ip })
    throw new HttpError(403, 'bad_invite', '注册码不对，或者已经用过、过期了。请找管理员要一个新的')
  }
  if (ctx.db.prepare('SELECT 1 FROM users WHERE username_norm = ?').get(norm)) {
    throw new HttpError(409, 'username_taken', '这个用户名已经有人用了，换一个吧')
  }
  const hash = await hashPassword(password, ctx.cfg.scryptLogN)
  const id = randomUUID()
  tx(ctx.db, () => {
    // 哈希期间注册码可能被别人用掉或撤销，写入前在事务里重新检查
    const inv = usableInvite(ctx, codeHash)
    if (!inv) throw new HttpError(403, 'bad_invite', '注册码不对，或者已经用过、过期了。请找管理员要一个新的')
    if (ctx.db.prepare('SELECT 1 FROM users WHERE username_norm = ?').get(norm)) throw new HttpError(409, 'username_taken', '这个用户名已经有人用了，换一个吧')
    const now = Date.now()
    ctx.db.prepare('INSERT INTO users (id, username, username_norm, role, password_hash, created_at, password_changed_at, invite_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, display, norm, 'user', hash, now, now, inv.id)
    ctx.db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ? AND uses < max_uses').run(inv.id)
    ctx.db.prepare('INSERT INTO invite_uses (invite_id, user_id, username, at) VALUES (?, ?, ?, ?)').run(inv.id, id, display, now)
    audit(ctx.db, 'register_ok', { userId: id, username: display, ip: r.ip, detail: `invite ${inv.id}` })
  })
  sendJson(r.res, 201, { ok: true })
}

/** 敏感操作前再验证一次密码。和登录共用失败锁定，偷到会话的人也没法借此猜密码 */
export async function reauth(ctx: Ctx, r: Req, a: Auth, pw: string, failEvent: string) {
  const locked = loginLocked(ctx, a.user.username_norm, r.ip)
  if (locked) throw lockedError(locked)
  if (!(await verifyPassword(pw, a.user.password_hash))) {
    loginFailed(ctx, a.user.username_norm, r.ip)
    audit(ctx.db, failEvent, { userId: a.user.id, username: a.user.username, ip: r.ip })
    throw new HttpError(403, 'bad_password', '密码不对')
  }
}

/** 修改密码：要验证当前密码；成功后其他设备全部退出 */
export async function changePassword(ctx: Ctx, r: Req) {
  const a = requireUser(r)
  limit(ctx.limits.authIp, r.ip)
  const body = await readJson(r.req)
  const current = str(body, 'current', 512)
  const next = str(body, 'next', 512)
  await reauth(ctx, r, a, current, 'password_change_fail')
  checkPassword(next, a.user.username_norm)
  if (current === next) throw new HttpError(400, 'same_password', '新密码和旧密码一样')
  const hash = await hashPassword(next, ctx.cfg.scryptLogN)
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(hash, Date.now(), a.user.id)
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id_hash != ?').run(a.user.id, a.sessionHash)
    audit(ctx.db, 'password_changed', { userId: a.user.id, username: a.user.username, ip: r.ip })
  })
  sendJson(r.res, 200, { ok: true })
}

export async function logoutAll(ctx: Ctx, r: Req) {
  const a = requireUser(r)
  ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(a.user.id)
  audit(ctx.db, 'logout_all', { userId: a.user.id, username: a.user.username, ip: r.ip })
  clearSessionCookie(ctx, r)
  sendJson(r.res, 200, { ok: true })
}

/** 当前账号已登录的设备 */
export async function sessions(ctx: Ctx, r: Req) {
  const a = requireUser(r)
  const rows = ctx.db.prepare('SELECT id_hash, kind, created_at, last_seen, ip, ua FROM sessions WHERE user_id = ? ORDER BY last_seen DESC').all(a.user.id) as { id_hash: string; kind: string; created_at: number; last_seen: number; ip: string; ua: string }[]
  sendJson(r.res, 200, { sessions: rows.map((s) => ({ current: s.id_hash === a.sessionHash, kind: s.kind, createdAt: s.created_at, lastSeen: s.last_seen, ip: s.ip, ua: s.ua })) })
}
