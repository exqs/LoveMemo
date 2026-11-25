// 账号相关的攻击用例：抢注管理员、暴力破解、注册码、会话、越权
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ADMIN, invite, login, registerUser, sessionCookie, setupAdmin, startServer } from './helpers.ts'

test('首次安装：没有安装码不能创建管理员；安装码错误被拒绝；只能创建一次', async () => {
  const s = await startServer()
  try {
    assert.equal((await s.req('/api/auth/state')).json.needsSetup, true)
    // 还没初始化时不能注册、不能登录
    assert.equal((await s.req('/api/auth/register', { json: { inviteCode: 'x', username: 'evil', password: 'aaaaaaaaaaaaaaa1' } })).status, 409)
    const bad = await s.req('/api/auth/setup', { json: { setupCode: 'AAAAA-AAAAA-AAAAA-AAAAA-AAAAA', ...ADMIN } })
    assert.equal(bad.status, 403)
    const none = await s.req('/api/auth/setup', { json: { ...ADMIN } })
    assert.equal(none.status, 400)
    // 弱密码被拒绝
    const weak = await s.req('/api/auth/setup', { json: { setupCode: s.setupCode, username: 'admin', password: '12345678' } })
    assert.equal(weak.status, 400)
    // 输入时大小写、横线、空格都可以随意
    const sloppy = s.setupCode.toLowerCase().replace(/-/g, ' ')
    const ok = await s.req('/api/auth/setup', { json: { setupCode: sloppy, ...ADMIN } })
    assert.equal(ok.status, 201, ok.text)
    // 再来一次（哪怕安装码正确）也不行
    const again = await s.req('/api/auth/setup', { json: { setupCode: s.setupCode, username: 'second', password: 'another good pass 42' } })
    assert.equal(again.status, 409)
    assert.equal((await s.req('/api/auth/state')).json.needsSetup, false)
    const users = s.ctx.db.prepare('SELECT role FROM users').all() as { role: string }[]
    assert.deepEqual(users.map((u) => u.role), ['superadmin'])
  } finally { await s.close() }
})

test('首次安装：并发抢注只有一个成功', async () => {
  const s = await startServer()
  try {
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => s.req('/api/auth/setup', { json: { setupCode: s.setupCode, username: 'racer' + i, password: 'race condition pass ' + i } })))
    assert.equal(rs.filter((r) => r.status === 201).length, 1)
    assert.equal((s.ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1)
  } finally { await s.close() }
})

test('安装码猜测被按 IP 限速', async () => {
  const s = await startServer()
  try {
    let limited = false
    for (let i = 0; i < 12; i++) {
      const r = await s.req('/api/auth/setup', { json: { setupCode: 'WRONG-' + i, ...ADMIN } })
      if (r.status === 429) { limited = true; break }
    }
    assert.ok(limited, '应该被限速')
  } finally { await s.close() }
})

test('登录：错误提示不区分"用户不存在"和"密码错误"；连续错 5 次后锁定，锁定期间正确密码也无效', async () => {
  const s = await startServer({ TRUST_PROXY: '1' })
  try {
    await setupAdmin(s)
    const attacker = { 'x-forwarded-for': '203.0.113.7' }
    const ghost = await s.req('/api/auth/login', { headers: attacker, json: { username: 'nobody', password: 'whatever whatever' } })
    const wrong = await s.req('/api/auth/login', { headers: attacker, json: { username: ADMIN.username, password: 'whatever whatever' } })
    assert.equal(ghost.status, 401)
    assert.equal(wrong.status, 401)
    assert.equal(ghost.json.message, wrong.json.message)
    for (let i = 0; i < 3; i++) await s.req('/api/auth/login', { headers: attacker, json: { username: ADMIN.username, password: 'guess ' + i } })
    const fifth = await s.req('/api/auth/login', { headers: attacker, json: { username: ADMIN.username, password: 'guess 4' } })
    assert.equal(fifth.status, 429)
    assert.equal(fifth.json.error, 'locked')
    // 攻击者这时就算猜对了也登不进去
    const right = await s.req('/api/auth/login', { headers: attacker, json: { username: ADMIN.username, password: ADMIN.password } })
    assert.equal(right.status, 429)
    // 真正的管理员从自己的 IP 仍然能登录：攻击者没法把管理员锁在门外
    const owner = await s.req('/api/auth/login', { headers: { 'x-forwarded-for': '198.51.100.20' }, json: { username: ADMIN.username, password: ADMIN.password } })
    assert.equal(owner.status, 200)
    // 用户名大小写不同视为同一个账号，不能借此绕过锁定
    const upper = await s.req('/api/auth/login', { headers: attacker, json: { username: ADMIN.username.toUpperCase(), password: ADMIN.password } })
    assert.equal(upper.status, 429)
  } finally { await s.close() }
})

test('登录：换很多 IP 分布式猜同一个账号，累计 30 次后整个账号暂时锁定', async () => {
  const s = await startServer({ TRUST_PROXY: '1' })
  try {
    await setupAdmin(s)
    let lockedAt = -1
    for (let i = 0; i < 40; i++) {
      const r = await s.req('/api/auth/login', { headers: { 'x-forwarded-for': `203.0.113.${i + 1}` }, json: { username: ADMIN.username, password: 'distributed ' + i } })
      if (r.status === 429) { lockedAt = i; break }
    }
    assert.equal(lockedAt, 29)
  } finally { await s.close() }
})

test('登录接口整体按 IP 限速（不管猜哪个用户名）', async () => {
  const s = await startServer()
  try {
    await setupAdmin(s)
    let limited = false
    for (let i = 0; i < 25; i++) {
      const r = await s.req('/api/auth/login', { json: { username: 'user' + i, password: 'spray spray spray' } })
      if (r.status === 429 && r.json.error === 'rate_limited') { limited = true; break }
    }
    assert.ok(limited)
  } finally { await s.close() }
})

test('没有配置 TRUST_PROXY 时，伪造 X-Forwarded-For 无法绕过限速', async () => {
  const s = await startServer()
  try {
    await setupAdmin(s)
    let limited = false
    for (let i = 0; i < 25; i++) {
      const r = await s.req('/api/auth/login', { headers: { 'x-forwarded-for': `10.0.${i}.1` }, json: { username: 'x' + i, password: 'spray spray spray' } })
      if (r.status === 429) { limited = true; break }
    }
    assert.ok(limited)
  } finally { await s.close() }
})

test('会话 Cookie：HttpOnly、Secure、SameSite=Strict、__Host- 前缀', async () => {
  const s = await startServer()
  try {
    await s.req('/api/auth/setup', { json: { setupCode: s.setupCode, ...ADMIN } })
    const r = await s.req('/api/auth/login', { json: ADMIN })
    const c = String(r.headers['set-cookie'])
    assert.match(c, /^__Host-lm_sid=[A-Za-z0-9_-]{43};/)
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(c.includes(flag), flag)
    assert.ok(!/Domain=/i.test(c))
    // 网页登录的响应里不带令牌
    assert.equal(r.json.token, undefined)
    // 服务器只存令牌的哈希
    const token = sessionCookie(r).split('=')[1]
    const rows = s.ctx.db.prepare('SELECT id_hash FROM sessions').all() as { id_hash: string }[]
    assert.ok(rows.every((x) => x.id_hash !== token && /^[0-9a-f]{64}$/.test(x.id_hash)))
  } finally { await s.close() }
})

test('注册：必须有效的注册码；注册码一次性、过期和撤销后不能用；并发也不能多用', async () => {
  const s = await startServer({ TRUST_PROXY: '1' })
  try {
    const admin = await setupAdmin(s)
    const ip = (n: number) => ({ 'x-forwarded-for': `192.0.2.${n}` })
    const none = await s.req('/api/auth/register', { headers: ip(1), json: { inviteCode: '', username: 'u1', password: 'good password 1234' } })
    assert.equal(none.status, 403)
    const fake = await s.req('/api/auth/register', { headers: ip(1), json: { inviteCode: '00000-00000-00000-00000-00000', username: 'u1', password: 'good password 1234' } })
    assert.equal(fake.status, 403)

    const inv = await invite(s, admin)
    // 服务器上不存明文
    const stored = s.ctx.db.prepare('SELECT code_hash FROM invites WHERE id = ?').get(inv.id) as { code_hash: string }
    assert.notEqual(stored.code_hash, inv.code)
    assert.ok(!JSON.stringify(s.ctx.db.prepare('SELECT * FROM invites').all()).includes(inv.code.replace(/-/g, '')))

    // 同一个码并发注册 5 个账号，只有 1 个成功
    const rs = await Promise.all([2, 3, 4, 5, 6].map((n) => s.req('/api/auth/register', { headers: ip(n), json: { inviteCode: inv.code, username: 'racer' + n, password: 'good password ' + n + n } })))
    assert.equal(rs.filter((r) => r.status === 201).length, 1, rs.map((r) => r.status).join(','))
    const used = s.ctx.db.prepare('SELECT uses FROM invites WHERE id = ?').get(inv.id) as { uses: number }
    assert.equal(used.uses, 1)

    // 撤销
    const inv2 = await invite(s, admin)
    assert.equal((await s.req(`/api/admin/invites/${inv2.id}/revoke`, { cookie: admin, json: {} })).status, 200)
    assert.equal((await s.req('/api/auth/register', { headers: ip(7), json: { inviteCode: inv2.code, username: 'late', password: 'good password 777' } })).status, 403)

    // 过期
    const inv3 = await invite(s, admin)
    s.ctx.db.prepare('UPDATE invites SET expires_at = ? WHERE id = ?').run(Date.now() - 1, inv3.id)
    assert.equal((await s.req('/api/auth/register', { headers: ip(8), json: { inviteCode: inv3.code, username: 'late2', password: 'good password 888' } })).status, 403)

    // 多次可用的码
    const inv4 = await invite(s, admin, 2)
    assert.equal((await s.req('/api/auth/register', { headers: ip(9), json: { inviteCode: inv4.code, username: 'm1', password: 'good password 991' } })).status, 201)
    assert.equal((await s.req('/api/auth/register', { headers: ip(10), json: { inviteCode: inv4.code, username: 'm2', password: 'good password 992' } })).status, 201)
    assert.equal((await s.req('/api/auth/register', { headers: ip(11), json: { inviteCode: inv4.code, username: 'm3', password: 'good password 993' } })).status, 403)

    // 不能注册成管理员：请求里带 role 也没用
    const inv5 = await invite(s, admin)
    await s.req('/api/auth/register', { headers: ip(12), json: { inviteCode: inv5.code, username: 'sneaky', password: 'good password 121', role: 'superadmin' } })
    const sneaky = s.ctx.db.prepare("SELECT role FROM users WHERE username_norm = 'sneaky'").get() as { role: string }
    assert.equal(sneaky.role, 'user')
    // 用户名不区分大小写，不能注册一个只差大小写的"管理员"
    const inv6 = await invite(s, admin)
    const dup = await s.req('/api/auth/register', { headers: ip(13), json: { inviteCode: inv6.code, username: ADMIN.username.toUpperCase(), password: 'good password 131' } })
    assert.equal(dup.status, 409)
  } finally { await s.close() }
})

test('注册码猜测：同一 IP 错 5 次后一小时内不能再试', async () => {
  const s = await startServer()
  try {
    await setupAdmin(s)
    const codes: number[] = []
    for (let i = 0; i < 7; i++) {
      const r = await s.req('/api/auth/register', { json: { inviteCode: `ABCDE-ABCDE-ABCDE-ABCDE-ABCD${i}`, username: 'g' + i, password: 'good password ' + i + i } })
      codes.push(r.status)
    }
    assert.deepEqual(codes.slice(0, 5), [403, 403, 403, 403, 403])
    assert.equal(codes[5], 429)
  } finally { await s.close() }
})

test('越权：普通用户不能调用任何管理接口；管理员不能删除或停用自己', async () => {
  const s = await startServer()
  try {
    const admin = await setupAdmin(s)
    const user = await registerUser(s, admin, 'alice')
    const adminId = (s.ctx.db.prepare("SELECT id FROM users WHERE role = 'superadmin'").get() as { id: string }).id
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/admin/invites'], ['POST', '/api/admin/invites', { maxUses: 1 }], ['GET', '/api/admin/users'], ['GET', '/api/admin/audit'],
      ['POST', `/api/admin/users/${adminId}/disable`, {}], ['POST', `/api/admin/users/${adminId}/delete`, { password: 'x' }],
    ]
    for (const [method, path, json] of calls) {
      const r = await s.req(path, { method, cookie: user, json })
      assert.equal(r.status, 403, `${method} ${path} → ${r.status}`)
      const anon = await s.req(path, { method, json })
      assert.equal(anon.status, 401, `匿名 ${method} ${path} → ${anon.status}`)
    }
    assert.equal((await s.req(`/api/admin/users/${adminId}/disable`, { cookie: admin, json: {} })).status, 400)
    assert.equal((await s.req(`/api/admin/users/${adminId}/delete`, { cookie: admin, json: { password: ADMIN.password } })).status, 400)
  } finally { await s.close() }
})

test('停用账号立刻踢下线；改密码后其他设备退出；退出后旧 Cookie 失效', async () => {
  const s = await startServer({ TRUST_PROXY: '1' })
  try {
    const admin = await setupAdmin(s)
    const bob = await registerUser(s, admin, 'bob', 'my secret phrase 12345')
    const bobId = (s.ctx.db.prepare("SELECT id FROM users WHERE username_norm = 'bob'").get() as { id: string }).id
    assert.equal((await s.req('/api/auth/state', { cookie: bob })).json.user.username, 'bob')
    await s.req(`/api/admin/users/${bobId}/disable`, { cookie: admin, json: {} })
    assert.equal((await s.req('/api/auth/state', { cookie: bob })).json.user, null)
    const relog = await s.req('/api/auth/login', { headers: { 'x-forwarded-for': '192.0.2.50' }, json: { username: 'bob', password: 'my secret phrase 12345' } })
    assert.equal(relog.status, 403)
    await s.req(`/api/admin/users/${bobId}/enable`, { cookie: admin, json: {} })

    const pc = await login(s, 'bob', 'my secret phrase 12345')
    const phone = await login(s, 'bob', 'my secret phrase 12345')
    const ch = await s.req('/api/account/password', { cookie: pc, json: { current: 'my secret phrase 12345', next: 'brand new phrase 678' } })
    assert.equal(ch.status, 200, ch.text)
    assert.equal((await s.req('/api/auth/state', { cookie: phone })).json.user, null)
    assert.equal((await s.req('/api/auth/state', { cookie: pc })).json.user.username, 'bob')

    await s.req('/api/auth/logout', { cookie: pc, json: {} })
    assert.equal((await s.req('/api/auth/state', { cookie: pc })).json.user, null)

    // 删除用户需要管理员再次输入密码
    const bad = await s.req(`/api/admin/users/${bobId}/delete`, { cookie: admin, json: { password: 'wrong' } })
    assert.equal(bad.status, 403)
    const del = await s.req(`/api/admin/users/${bobId}/delete`, { cookie: admin, json: { password: ADMIN.password } })
    assert.equal(del.status, 200)
    assert.equal(s.ctx.db.prepare("SELECT 1 FROM users WHERE username_norm = 'bob'").get(), undefined)
  } finally { await s.close() }
})

test('会话过期：超过闲置时间自动失效', async () => {
  const s = await startServer()
  try {
    const admin = await setupAdmin(s)
    s.ctx.db.prepare('UPDATE sessions SET last_seen = ?').run(Date.now() - 8 * 86400_000)
    assert.equal((await s.req('/api/auth/state', { cookie: admin })).json.user, null)
    assert.equal((s.ctx.db.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n, 0)
  } finally { await s.close() }
})

test('桌面令牌和网页 Cookie 不能混用；伪造、格式错误的令牌一律无效', async () => {
  const s = await startServer()
  try {
    await setupAdmin(s)
    const web = await s.req('/api/auth/login', { json: ADMIN })
    const webToken = sessionCookie(web).split('=')[1]
    assert.equal((await s.req('/api/auth/state', { bearer: webToken })).json.user, null)
    const desk = await s.req('/api/auth/login', { json: { ...ADMIN, client: 'desktop' } })
    assert.match(desk.json.token, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(desk.headers['set-cookie'], undefined)
    assert.equal((await s.req('/api/auth/state', { bearer: desk.json.token })).json.user.username, ADMIN.username)
    assert.equal((await s.req('/api/auth/state', { cookie: `__Host-lm_sid=${desk.json.token}` })).json.user, null)
    for (const t of ['x', 'A'.repeat(43), desk.json.token + 'A', "' OR 1=1 --"]) {
      assert.equal((await s.req('/api/auth/state', { headers: { authorization: `Bearer ${t}` } })).json.user, null)
    }
  } finally { await s.close() }
})

test('SQL 注入：用户名和密码里的 SQL 片段只被当作普通文字', async () => {
  const s = await startServer()
  try {
    await setupAdmin(s)
    for (const u of ["' OR '1'='1", "admin'--", "x\"; DROP TABLE users; --"]) {
      const r = await s.req('/api/auth/login', { json: { username: u, password: "' OR '1'='1' --" } })
      assert.equal(r.status, 401)
    }
    assert.equal((s.ctx.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n, 1)
  } finally { await s.close() }
})
