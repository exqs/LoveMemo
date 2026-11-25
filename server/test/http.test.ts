// 请求层的攻击用例：跨站请求、Host 伪造、路径穿越、超大请求、数据隔离、AI 转发
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ADMIN, fakeSqlite, registerUser, sessionCookie, setupAdmin, startServer } from './helpers.ts'

test('跨站请求（CSRF）：缺少自定义头、Origin 不对、Sec-Fetch-Site 是 cross-site 都被拒绝', async () => {
  const s = await startServer()
  try {
    const admin = await setupAdmin(s)
    const body = { maxUses: 1 }
    assert.equal((await s.req('/api/admin/invites', { cookie: admin, json: body, noCsrfHeader: true })).status, 403)
    assert.equal((await s.req('/api/admin/invites', { cookie: admin, json: body, headers: { origin: 'https://evil.example' } })).status, 403)
    assert.equal((await s.req('/api/admin/invites', { cookie: admin, json: body, headers: { origin: 'null' } })).status, 403)
    assert.equal((await s.req('/api/admin/invites', { cookie: admin, json: body, headers: { 'sec-fetch-site': 'cross-site' } })).status, 403)
    assert.equal((await s.req('/api/admin/invites', { cookie: admin, json: body, headers: { 'sec-fetch-site': 'same-site' } })).status, 403)
    // 表单提交的格式（text/plain、urlencoded）不被接受
    assert.equal((await s.req('/api/admin/invites', { cookie: admin, raw: '{"maxUses":1}', headers: { 'content-type': 'text/plain' } })).status, 415)
    // 同源正常请求可以
    assert.equal((await s.req('/api/admin/invites', { cookie: admin, json: body, headers: { origin: 'https://memo.test', 'sec-fetch-site': 'same-origin' } })).status, 201)
    // 不回应任何 CORS
    const pre = await s.req('/api/admin/invites', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })
    assert.equal(pre.headers['access-control-allow-origin'], undefined)
  } finally { await s.close() }
})

test('Host 头必须是配置的域名（防 DNS 重绑定、防直接用 IP 访问）', async () => {
  const s = await startServer()
  try {
    assert.equal((await s.req('/api/auth/state', { headers: { host: 'evil.example' } })).status, 421)
    assert.equal((await s.req('/api/auth/state', { headers: { host: '1.2.3.4' } })).status, 421)
    assert.equal((await s.req('/api/auth/state')).status, 200)
  } finally { await s.close() }
})

test('安全响应头', async () => {
  const s = await startServer()
  try {
    const r = await s.req('/api/auth/state')
    assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'none'/)
    assert.match(String(r.headers['content-security-policy']), /script-src 'self' 'wasm-unsafe-eval'/)
    const scriptSrc = String(r.headers['content-security-policy']).split(';').map((x) => x.trim()).find((x) => x.startsWith('script-src'))
    assert.equal(scriptSrc, "script-src 'self' 'wasm-unsafe-eval'")
    assert.equal(r.headers['x-frame-options'], 'DENY')
    assert.equal(r.headers['x-content-type-options'], 'nosniff')
    assert.match(String(r.headers['strict-transport-security']), /max-age=31536000/)
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.equal(r.headers['x-powered-by'], undefined)
  } finally { await s.close() }
})

test('静态文件：不能用 ../、编码过的 ../、隐藏文件读到网站目录之外的东西', async () => {
  const s = await startServer()
  try {
    const st = join(s.dir, 'static')
    mkdirSync(join(st, 'assets'), { recursive: true })
    writeFileSync(join(st, 'index.html'), '<!doctype html><title>ok</title>')
    writeFileSync(join(st, 'assets', 'a.js'), 'console.log(1)')
    writeFileSync(join(st, '.env'), 'SECRET=1')
    writeFileSync(join(s.dir, 'secret.txt'), 'TOP SECRET')
    assert.equal((await s.req('/')).status, 200)
    assert.equal((await s.req('/assets/a.js')).headers['cache-control'], 'public, max-age=31536000, immutable')
    for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/assets/..%2f..%2fsecret.txt', '/..%5csecret.txt', '/.env', '/assets/%00.js', '/../data/server.sqlite', '/%2e%2e/data/server.sqlite']) {
      const r = await s.req(p)
      assert.ok(!r.text.includes('TOP SECRET') && !r.text.includes('SECRET=1') && !r.text.includes('SQLite format'), p)
    }
    // 没有扩展名的路径回首页（前端路由），有扩展名但不存在的返回 404
    assert.equal((await s.req('/some/route')).status, 200)
    assert.equal((await s.req('/nope.js')).status, 404)
  } finally { await s.close() }
})

test('请求体大小限制：JSON 接口 64KB，超过立即拒绝', async () => {
  const s = await startServer()
  try {
    const r = await s.req('/api/auth/login', { json: { username: 'a', password: 'x'.repeat(200_000) } })
    assert.equal(r.status, 413)
  } finally { await s.close() }
})

test('数据：只能读写自己的；内容加密落盘；版本冲突；不是 SQLite 的内容被拒绝', async () => {
  const s = await startServer({ MAX_DATA_MB: '1' })
  try {
    const admin = await setupAdmin(s)
    const alice = await registerUser(s, admin, 'alice')
    const bob = await registerUser(s, admin, 'bob')
    assert.equal((await s.req('/api/data')).status, 401)
    const first = await s.req('/api/data', { cookie: alice })
    assert.equal(first.status, 204)
    const aliceOwner = String(first.headers['x-data-owner'])
    const bobOwner = String((await s.req('/api/data', { cookie: bob })).headers['x-data-owner'])
    const H = (v: number | string, owner = aliceOwner) => ({ 'content-type': 'application/octet-stream', 'x-data-version': String(v), 'x-data-owner': owner })

    const secret = fakeSqlite(0x41)
    secret.write('ALICE-PRIVATE-NOTE', 100)
    // 页面上是 bob 的数据、Cookie 却是 alice 的（中途换了账号），写入被拒绝
    const swapped = await s.req('/api/data', { method: 'PUT', cookie: alice, raw: secret, headers: H(0, bobOwner) })
    assert.equal(swapped.status, 409)
    assert.equal(swapped.json.error, 'wrong_owner')
    const noOwner = await s.req('/api/data', { method: 'PUT', cookie: alice, raw: secret, headers: { 'content-type': 'application/octet-stream', 'x-data-version': '0' } })
    assert.equal(noOwner.status, 409)
    const put = await s.req('/api/data', { method: 'PUT', cookie: alice, raw: secret, headers: H(0) })
    assert.equal(put.status, 200, put.text)
    assert.equal(put.json.version, 1)

    // bob 读到的是自己的（空的）
    assert.equal((await s.req('/api/data', { cookie: bob })).status, 204)
    const back = await s.req('/api/data', { cookie: alice })
    assert.equal(back.headers['x-data-version'], '1')
    assert.ok(back.body.equals(secret))

    // 磁盘上是密文
    const root = join(s.dir, 'data', 'userdata')
    for (const d of readdirSync(root)) for (const f of readdirSync(join(root, d))) {
      const raw = readFileSync(join(root, d, f))
      assert.ok(!raw.includes('ALICE-PRIVATE-NOTE') && !raw.includes('SQLite format'), '数据应该是加密的')
    }

    // 旧版本号写入 → 冲突，不会覆盖
    const stale = await s.req('/api/data', { method: 'PUT', cookie: alice, raw: fakeSqlite(0x42), headers: H(0) })
    assert.equal(stale.status, 409)
    assert.equal(stale.json.version, 1)

    // 不是 SQLite 文件
    const junk = await s.req('/api/data', { method: 'PUT', cookie: alice, raw: Buffer.alloc(4096, 1), headers: H(1) })
    assert.equal(junk.status, 400)
    // 超过大小上限
    const big = await s.req('/api/data', { method: 'PUT', cookie: alice, raw: fakeSqlite(1, 2 * 1024 * 1024), headers: H(1) })
    assert.equal(big.status, 413)
    // 缺少跨站防护头
    const csrf = await s.req('/api/data', { method: 'PUT', cookie: alice, raw: fakeSqlite(), noCsrfHeader: true, headers: H(1) })
    assert.equal(csrf.status, 403)

    // 只保留最近 3 个版本
    for (let v = 1; v <= 5; v++) {
      const r = await s.req('/api/data', { method: 'PUT', cookie: alice, raw: fakeSqlite(v), headers: H(v) })
      assert.equal(r.status, 200)
    }
    const aliceId = (s.ctx.db.prepare("SELECT id FROM users WHERE username_norm = 'alice'").get() as { id: string }).id
    assert.deepEqual(readdirSync(join(root, aliceId)).sort(), ['4.bin', '5.bin', '6.bin'])

    // 管理员也读不到别人的数据（没有任何接口）
    const asAdmin = await s.req('/api/data', { cookie: admin })
    assert.equal(asAdmin.status, 204)
  } finally { await s.close() }
})

test('数据文件被挪到别人的目录下也解不开（加密绑定了用户和版本）', async () => {
  const s = await startServer()
  try {
    const admin = await setupAdmin(s)
    const alice = await registerUser(s, admin, 'alice')
    const bob = await registerUser(s, admin, 'bob')
    const owner = async (c: string) => String((await s.req('/api/data', { cookie: c })).headers['x-data-owner'])
    const h = (o: string) => ({ 'content-type': 'application/octet-stream', 'x-data-version': '0', 'x-data-owner': o })
    assert.equal((await s.req('/api/data', { method: 'PUT', cookie: alice, raw: fakeSqlite(7), headers: h(await owner(alice)) })).status, 200)
    assert.equal((await s.req('/api/data', { method: 'PUT', cookie: bob, raw: fakeSqlite(8), headers: h(await owner(bob)) })).status, 200)
    const ids = Object.fromEntries((s.ctx.db.prepare('SELECT username_norm AS u, id FROM users').all() as { u: string; id: string }[]).map((x) => [x.u, x.id]))
    const root = join(s.dir, 'data', 'userdata')
    writeFileSync(join(root, ids.bob, '1.bin'), readFileSync(join(root, ids.alice, '1.bin')))
    const r = await s.req('/api/data', { cookie: bob })
    assert.equal(r.status, 500)
    assert.ok(!r.body.includes(Buffer.alloc(64, 7)))
  } finally { await s.close() }
})

test('配置：缺少密钥、密钥太弱、没有明确选择 http 却用了 http 地址时拒绝启动', async () => {
  const { loadConfig } = await import('../src/config.ts')
  const key = Buffer.alloc(32, 9).toString('base64')
  const good = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64')
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'https://memo.test' }))
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'https://memo.test', DATA_KEY: 'short' }))
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'https://memo.test', DATA_KEY: key }))
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'http://memo.test', DATA_KEY: good }))
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'https://memo.test/path', DATA_KEY: good }))
  assert.throws(() => loadConfig({ PUBLIC_ORIGIN: 'https://memo.test', DATA_KEY: good, SCRYPT_LOG_N: '10' }))
  assert.doesNotThrow(() => loadConfig({ PUBLIC_ORIGIN: 'https://memo.test', DATA_KEY: good }))
  assert.doesNotThrow(() => loadConfig({ PUBLIC_ORIGIN: 'http://localhost:1420', DATA_KEY: good }))

  // SCHEME + DOMAIN（Docker 部署的写法）
  const https = loadConfig({ SCHEME: 'https', DOMAIN: 'Memo.Test', DATA_KEY: good })
  assert.equal(https.publicOrigin, 'https://memo.test')
  assert.equal(https.secureCookies, true)
  const http = loadConfig({ SCHEME: 'http', DOMAIN: 'memo.test', DATA_KEY: good })
  assert.equal(http.publicOrigin, 'http://memo.test')
  assert.equal(http.publicHost, 'memo.test')
  assert.equal(http.secureCookies, false)
  assert.equal(http.plainHttp, true)
  assert.equal(https.plainHttp, false)
  assert.equal(loadConfig({ PUBLIC_ORIGIN: 'http://localhost:1420', DATA_KEY: good }).plainHttp, false)
  assert.equal(loadConfig({ SCHEME: 'http', DOMAIN: '10.0.0.5', DATA_KEY: good }).publicHost, '10.0.0.5')
  assert.doesNotThrow(() => loadConfig({ SCHEME: 'http', PUBLIC_ORIGIN: 'http://memo.test', DATA_KEY: good }))
  assert.throws(() => loadConfig({ DOMAIN: 'memo.test', DATA_KEY: good }), /SCHEME/)
  assert.throws(() => loadConfig({ SCHEME: 'ftp', DOMAIN: 'memo.test', DATA_KEY: good }), /https 或 http/)
  assert.throws(() => loadConfig({ SCHEME: 'https,http', DOMAIN: 'memo.test', DATA_KEY: good }), /https 或 http/)
  assert.throws(() => loadConfig({ SCHEME: 'http', DATA_KEY: good }))
  for (const bad of ['http://memo.test', 'memo.test:8080', 'memo.test/x', 'a b', 'memo.test@evil.com', '']) {
    assert.throws(() => loadConfig({ SCHEME: 'https', DOMAIN: bad, DATA_KEY: good }), bad)
  }
  assert.throws(() => loadConfig({ SCHEME: 'https', PUBLIC_ORIGIN: 'http://memo.test', DATA_KEY: good }), /不一致/)

  // ACCESS_MODE（来自 COMPOSE_PROFILES）的三种方式
  const m1 = loadConfig({ ACCESS_MODE: 'https', DOMAIN: 'memo.test', DATA_KEY: good })
  assert.equal(m1.publicOrigin, 'https://memo.test')
  assert.equal(m1.accessMode, 'https')
  const m2 = loadConfig({ ACCESS_MODE: 'http', DOMAIN: 'memo.test', DATA_KEY: good })
  assert.equal(m2.publicOrigin, 'http://memo.test')
  assert.equal(m2.plainHttp, true)
  const m3 = loadConfig({ ACCESS_MODE: 'https-ip', SERVER_IP: '47.100.1.2', DATA_KEY: good })
  assert.equal(m3.publicOrigin, 'https://47.100.1.2:8443')
  assert.equal(m3.publicHost, '47.100.1.2:8443')
  assert.equal(m3.secureCookies, true)
  assert.equal(m3.plainHttp, false)
  const m3b = loadConfig({ ACCESS_MODE: 'https-ip', SERVER_IP: '47.100.1.2', HTTPS_PORT: '9443', DOMAIN: 'ignored.test', DATA_KEY: good })
  assert.equal(m3b.publicOrigin, 'https://47.100.1.2:9443')
  assert.equal(loadConfig({ ACCESS_MODE: 'https-ip', SERVER_IP: '47.100.1.2', HTTPS_PORT: '443', DATA_KEY: good }).publicOrigin, 'https://47.100.1.2')
  for (const ip of ['', 'memo.test', '47.100.1', '47.100.1.256', '47.100.1.2:8443', '::1', ' 1.2.3.4 x']) {
    assert.throws(() => loadConfig({ ACCESS_MODE: 'https-ip', SERVER_IP: ip, DATA_KEY: good }), /SERVER_IP/, ip)
  }
  for (const port of ['80', '0', '70000', 'abc', '8443.5']) {
    assert.throws(() => loadConfig({ ACCESS_MODE: 'https-ip', SERVER_IP: '47.100.1.2', HTTPS_PORT: port, DATA_KEY: good }), /HTTPS_PORT/, port)
  }
  assert.throws(() => loadConfig({ ACCESS_MODE: 'https', DOMAIN: '47.100.1.2', DATA_KEY: good }), /https-ip/)
  assert.throws(() => loadConfig({ ACCESS_MODE: 'https', DATA_KEY: good }), /DOMAIN/)
  for (const bad of ['https,http', 'https-ip,http', 'constructor', 'toString', 'HTTPS IP']) {
    assert.throws(() => loadConfig({ ACCESS_MODE: bad, DOMAIN: 'memo.test', SERVER_IP: '47.100.1.2', DATA_KEY: good }), /只能是/, bad)
  }
  assert.throws(() => loadConfig({ ACCESS_MODE: 'https-ip', SCHEME: 'http', SERVER_IP: '47.100.1.2', DATA_KEY: good }), /不一致/)
  assert.throws(() => loadConfig({ SCHEME: 'http', PUBLIC_ORIGIN: 'https://memo.test', DATA_KEY: good }), /不一致/)
})

test('http 模式：登录、改数据、CSRF 校验照常工作；Cookie 不带 Secure，没有 HSTS', async () => {
  const s = await startServer({ PUBLIC_ORIGIN: 'http://memo.test', SCHEME: 'http' })
  try {
    const home = await s.req('/')
    assert.equal(home.headers['strict-transport-security'], undefined)
    assert.match(String(home.headers['content-security-policy']), /default-src 'self'/)
    const st = await s.req('/api/auth/setup', { json: { setupCode: s.setupCode, ...ADMIN } })
    assert.equal(st.status, 201)
    const lr = await s.req('/api/auth/login', { json: { username: ADMIN.username, password: ADMIN.password } })
    assert.equal(lr.status, 200)
    const set = String(lr.headers['set-cookie'])
    const cookie = sessionCookie(lr)
    assert.match(cookie, /^lm_sid=/)
    assert.ok(!/;\s*Secure/i.test(set), set)
    assert.match(set, /HttpOnly/)
    assert.match(set, /SameSite=Strict/)
    const me = await s.req('/api/auth/state', { cookie })
    assert.equal(me.status, 200)
    // 别的网站发来的请求仍然被拒绝（http 下浏览器不带 Sec-Fetch-Site，只靠 Origin 和自定义头）
    const evil = await s.req('/api/auth/logout', { method: 'POST', cookie, headers: { origin: 'http://evil.test' } })
    assert.equal(evil.status, 403)
    const noHeader = await s.req('/api/auth/logout', { method: 'POST', cookie, noCsrfHeader: true })
    assert.equal(noHeader.status, 403)
    const https = await s.req('/api/auth/logout', { method: 'POST', cookie, headers: { origin: 'https://memo.test' } })
    assert.equal(https.status, 403)
  } finally { await s.close() }
})

test('https-ip 模式：Host 和 Origin 带端口，校验照常', async () => {
  const s = await startServer({ PUBLIC_ORIGIN: '', ACCESS_MODE: 'https-ip', SERVER_IP: '47.100.1.2', HTTPS_PORT: '8443' })
  try {
    assert.equal(s.ctx.cfg.publicHost, '47.100.1.2:8443')
    // 默认的 memo.test Host 头不对
    assert.equal((await s.req('/api/auth/state')).status, 421)
    const host = { host: '47.100.1.2:8443' }
    assert.equal((await s.req('/api/auth/state', { headers: host })).status, 200)
    // 不带端口的 IP 也不行（防止绕过）
    assert.equal((await s.req('/api/auth/state', { headers: { host: '47.100.1.2' } })).status, 421)
    const st = await s.req('/api/auth/setup', { headers: { ...host, origin: 'https://47.100.1.2:8443' }, json: { setupCode: s.setupCode, ...ADMIN } })
    assert.equal(st.status, 201)
    const lr = await s.req('/api/auth/login', { headers: host, json: { username: ADMIN.username, password: ADMIN.password } })
    assert.equal(lr.status, 200)
    assert.match(String(lr.headers['set-cookie']), /^__Host-lm_sid=.*Secure/)
    const cookie = sessionCookie(lr)
    const wrongPort = await s.req('/api/auth/logout', { method: 'POST', cookie, headers: { ...host, origin: 'https://47.100.1.2:9443' } })
    assert.equal(wrongPort.status, 403)
    const ok = await s.req('/api/auth/logout', { method: 'POST', cookie, headers: { ...host, origin: 'https://47.100.1.2:8443' }, json: {} })
    assert.equal(ok.status, 200)
  } finally { await s.close() }
})

test('没有任何"万能密码"、调试开关或隐藏接口', async () => {
  const s = await startServer({ DEBUG: '1', ADMIN_PASSWORD: 'letmein1234', NODE_ENV: 'development' })
  try {
    await setupAdmin(s)
    assert.equal((await s.req('/api/auth/login', { json: { username: ADMIN.username, password: 'letmein1234' } })).status, 401)
    for (const p of ['/api/debug', '/api/admin/login-as', '/api/admin/users/x/password', '/api/admin/data', '/api/admin/sql', '/api/eval']) {
      for (const method of ['GET', 'POST']) {
        const r = await s.req(p, { method, json: method === 'POST' ? {} : undefined })
        assert.ok(r.status === 404 || r.status === 405, `${method} ${p} → ${r.status}`)
      }
    }
  } finally { await s.close() }
})
