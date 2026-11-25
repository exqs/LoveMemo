// 超级管理员：注册码、用户管理、安全日志。
// 管理员看不到也读不到任何用户的便签内容，也不能替别人设置密码或以别人身份登录。
import { randomUUID } from 'node:crypto'
import type { Ctx, Req } from './context.ts'
import { audit, tx, type UserRow } from './db.ts'
import { humanCode, normalizeCode, sha256Hex } from './crypto.ts'
import { HttpError, readJson, sendJson, str } from './http.ts'
import { reauth, requireAdmin } from './auth.ts'

function intField(o: Record<string, unknown>, k: string, min: number, max: number, def: number): number {
  const v = o[k]
  if (v === undefined || v === null) return def
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new HttpError(400, 'bad_field', `${k} 要在 ${min}~${max} 之间`)
  return v
}

export async function createInvite(ctx: Ctx, r: Req) {
  const a = requireAdmin(r)
  const body = await readJson(r.req)
  const maxUses = intField(body, 'maxUses', 1, 50, 1)
  const hours = intField(body, 'expiresHours', 1, 24 * 30, 72)
  const note = typeof body.note === 'string' ? body.note.slice(0, 100) : ''
  const open = (ctx.db.prepare('SELECT COUNT(*) AS n FROM invites WHERE revoked_at IS NULL AND uses < max_uses AND expires_at > ?').get(Date.now()) as { n: number }).n
  if (open >= 100) throw new HttpError(400, 'too_many', '还能用的注册码已经有 100 个了，先撤销一些吧')
  const code = humanCode(5)
  const id = randomUUID()
  const now = Date.now()
  ctx.db.prepare('INSERT INTO invites (id, code_hash, note, max_uses, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, sha256Hex(normalizeCode(code)), note, maxUses, now + hours * 3600_000, a.user.id, now)
  audit(ctx.db, 'invite_created', { userId: a.user.id, username: a.user.username, ip: r.ip, detail: `${id} uses=${maxUses} hours=${hours}` })
  // 明文只在这里返回这一次，库里只有哈希
  sendJson(r.res, 201, { id, code, maxUses, expiresAt: now + hours * 3600_000, note })
}

export async function listInvites(ctx: Ctx, r: Req) {
  requireAdmin(r)
  const rows = ctx.db.prepare('SELECT id, note, max_uses, uses, expires_at, created_at, revoked_at FROM invites ORDER BY created_at DESC LIMIT 200').all() as { id: string; note: string; max_uses: number; uses: number; expires_at: number; created_at: number; revoked_at: number | null }[]
  const uses = ctx.db.prepare('SELECT username, at FROM invite_uses WHERE invite_id = ? ORDER BY at')
  const now = Date.now()
  sendJson(r.res, 200, {
    invites: rows.map((i) => ({
      id: i.id, note: i.note, maxUses: i.max_uses, uses: i.uses, expiresAt: i.expires_at, createdAt: i.created_at, revokedAt: i.revoked_at,
      status: i.revoked_at ? 'revoked' : i.uses >= i.max_uses ? 'used' : i.expires_at < now ? 'expired' : 'active',
      usedBy: (uses.all(i.id) as { username: string; at: number }[]).map((u) => ({ username: u.username, at: u.at })),
    })),
  })
}

export async function revokeInvite(ctx: Ctx, r: Req, id: string) {
  const a = requireAdmin(r)
  const n = ctx.db.prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id).changes
  if (!n) throw new HttpError(404, 'not_found', '找不到这个注册码')
  audit(ctx.db, 'invite_revoked', { userId: a.user.id, username: a.user.username, ip: r.ip, detail: id })
  sendJson(r.res, 200, { ok: true })
}

export async function listUsers(ctx: Ctx, r: Req) {
  requireAdmin(r)
  const today = new Date().toISOString().slice(0, 10)
  const rows = ctx.db.prepare(`SELECT u.id, u.username, u.role, u.disabled, u.created_at, u.last_login_at, u.data_size,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sessions,
      COALESCE((SELECT calls FROM llm_usage l WHERE l.user_id = u.id AND l.day = ?), 0) AS calls_today,
      COALESCE((SELECT SUM(calls) FROM llm_usage l WHERE l.user_id = u.id), 0) AS calls_total
    FROM users u ORDER BY u.created_at`).all(today) as Record<string, number | string | null>[]
  sendJson(r.res, 200, {
    users: rows.map((u) => ({
      id: u.id, username: u.username, role: u.role, disabled: !!u.disabled, createdAt: u.created_at, lastLoginAt: u.last_login_at,
      dataSize: u.data_size, sessions: u.sessions, callsToday: u.calls_today, callsTotal: u.calls_total,
    })),
  })
}

function targetUser(ctx: Ctx, id: string, adminId: string): UserRow {
  const u = ctx.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
  if (!u) throw new HttpError(404, 'not_found', '找不到这个用户')
  if (u.id === adminId || u.role === 'superadmin') throw new HttpError(400, 'forbidden', '不能对管理员自己这样做')
  return u
}

export async function setDisabled(ctx: Ctx, r: Req, id: string, disabled: boolean) {
  const a = requireAdmin(r)
  const u = targetUser(ctx, id, a.user.id)
  tx(ctx.db, () => {
    ctx.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, u.id)
    if (disabled) ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id)
    audit(ctx.db, disabled ? 'user_disabled' : 'user_enabled', { userId: a.user.id, username: a.user.username, ip: r.ip, detail: u.username })
  })
  sendJson(r.res, 200, { ok: true })
}

/** 删除用户及其全部数据。不可恢复，所以要求管理员再输一次自己的密码 */
export async function deleteUser(ctx: Ctx, r: Req, id: string) {
  const a = requireAdmin(r)
  const body = await readJson(r.req)
  const u = targetUser(ctx, id, a.user.id)
  await reauth(ctx, r, a, str(body, 'password', 512), 'admin_reauth_fail')
  tx(ctx.db, () => {
    ctx.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id)
    ctx.db.prepare('DELETE FROM llm_usage WHERE user_id = ?').run(u.id)
    ctx.db.prepare('DELETE FROM users WHERE id = ?').run(u.id)
    audit(ctx.db, 'user_deleted', { userId: a.user.id, username: a.user.username, ip: r.ip, detail: u.username })
  })
  await ctx.data.remove(u.id)
  sendJson(r.res, 200, { ok: true })
}

export async function listAudit(ctx: Ctx, r: Req) {
  requireAdmin(r)
  const rows = ctx.db.prepare('SELECT at, username, event, ip, detail FROM audit ORDER BY id DESC LIMIT 300').all()
  sendJson(r.res, 200, { events: rows })
}
