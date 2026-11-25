// AI 服务商与模型：管理员配置流程、Key 不外泄、不能拿服务器访问内网、转发白名单
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ADMIN, addProvider, registerUser, setupAdmin, startServer } from './helpers.ts'
import { isBlockedIp } from '../src/upstream.ts'

/** 假的模型服务：记录收到的请求，/models 返回模型列表，/chat/completions 返回回答 */
async function mockUpstream() {
  const seen: { url: string; headers: IncomingHttpHeaders; body: Record<string, unknown> | null }[] = []
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      seen.push({ url: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : null })
      res.setHeader('content-type', 'application/json')
      if (req.headers.authorization !== 'Bearer sk-good-key-123456' && req.headers['x-api-key'] !== 'sk-good-key-123456') { res.statusCode = 401; res.end('{"error":{"message":"bad key"}}'); return }
      if (req.url?.startsWith('/redirect')) { res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }); res.end(); return }
      if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'deepseek-flash' }, { id: 'qwen-vl-max' }, { id: 'deepseek-reasoner' }] })); return }
      if (req.url?.startsWith('/anth/v1/models')) { res.end(JSON.stringify({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }], has_more: false })); return }
      res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }))
    })
  })
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()))
  return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen, close: () => srv.close() }
}

test('完整流程：填地址和 Key → 获取模型列表 → 多选添加 → 普通用户能用；Key 任何时候都不返回', async () => {
  const up = await mockUpstream()
  const s = await startServer({ ALLOW_PRIVATE_LLM_HOSTS: '1', LLM_DAILY_LIMIT: '5' })
  try {
    const admin = await setupAdmin(s)
    const user = await registerUser(s, admin, 'carol')
    // 获取模型列表：Key 错误
    const badKey = await s.req('/api/admin/llm/probe', { cookie: admin, json: { protocol: 'openai', base_url: up.base + '/v1', api_key: 'sk-wrong' } })
    assert.equal(badKey.status, 400)
    assert.equal(badKey.json.error, 'upstream_auth')
    const probe = await s.req('/api/admin/llm/probe', { cookie: admin, json: { protocol: 'openai', base_url: up.base + '/v1/', api_key: 'sk-good-key-123456' } })
    assert.equal(probe.status, 200, probe.text)
    assert.deepEqual(probe.json.models.map((m: { id: string }) => m.id), ['deepseek-flash', 'deepseek-reasoner', 'qwen-vl-max'])
    // 普通用户不能获取列表、不能添加
    assert.equal((await s.req('/api/admin/llm/probe', { cookie: user, json: { protocol: 'openai', base_url: up.base + '/v1', api_key: 'x' } })).status, 403)
    assert.equal((await s.req('/api/admin/llm', { cookie: user })).status, 403)
    // 添加服务商要输管理员密码
    const noPw = await s.req('/api/admin/llm/providers', { cookie: admin, json: { protocol: 'openai', base_url: up.base + '/v1', api_key: 'sk-good-key-123456', models: ['deepseek-flash'], password: 'wrong' } })
    assert.equal(noPw.status, 403)
    const { providerId, models } = await addProvider(s, admin, { base_url: up.base + '/v1', api_key: 'sk-good-key-123456', models: ['deepseek-flash', 'qwen-vl-max'] })
    assert.equal(models.length, 2)
    const vl = models.find((m) => m.model === 'qwen-vl-max') as unknown as { supports_vision: boolean }
    assert.equal(vl.supports_vision, true)

    // 管理页、用户模型列表里都没有 Key；数据库里是密文
    const adminView = await s.req('/api/admin/llm', { cookie: admin })
    assert.ok(!adminView.text.includes('sk-good-key-123456'))
    assert.equal(adminView.json.providers[0].hasKey, true)
    assert.equal(adminView.json.providers[0].keyHint, '3456')
    const userView = await s.req('/api/models', { cookie: user })
    assert.ok(!userView.text.includes('sk-good-key') && !userView.text.includes(up.base))
    assert.equal(userView.json.models.length, 2)
    const row = s.ctx.db.prepare('SELECT key_enc FROM llm_providers').get() as { key_enc: Uint8Array }
    assert.ok(!Buffer.from(row.key_enc).includes('sk-good-key'))

    // 用户调用：服务器补上 Key，前端塞的地址、模型名、多余字段都被丢掉
    const flash = models.find((m) => m.model === 'deepseek-flash')!
    up.seen.length = 0
    const r = await s.req('/api/llm', { cookie: user, json: {
      profileId: flash.id,
      body: { model: 'gpt-expensive', url: 'http://169.254.169.254/', stream: true, tools: [{ type: 'function' }], n: 50, max_tokens: 9_999_999, messages: [{ role: 'user', content: 'hi', name: 'x' }] },
    } })
    assert.equal(r.status, 200, r.text)
    assert.equal(r.json.status, 200)
    const call = up.seen[0]
    assert.equal(call.url, '/v1/chat/completions')
    assert.equal(call.headers.authorization, 'Bearer sk-good-key-123456')
    assert.equal(call.body!.model, 'deepseek-flash')
    assert.equal(call.body!.max_tokens, 8192)
    for (const k of ['url', 'stream', 'tools', 'n']) assert.equal(call.body![k], undefined, k)
    assert.deepEqual(call.body!.messages, [{ role: 'user', content: 'hi' }])
    assert.ok(!r.text.includes('sk-good-key'))

    // 图片只能是内嵌数据
    const img = await s.req('/api/llm', { cookie: user, json: { profileId: flash.id, body: { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://169.254.169.254/' } }] }] } } })
    assert.equal(img.status, 400)

    // 关掉模型 / 关掉服务商后用户就用不了
    await s.req(`/api/admin/llm/models/${flash.id}/update`, { cookie: admin, json: { enabled: false } })
    assert.equal((await s.req('/api/llm', { cookie: user, json: { profileId: flash.id, body: { messages: [{ role: 'user', content: 'x' }] } } })).status, 404)
    assert.equal((await s.req('/api/models', { cookie: user })).json.models.length, 1)
    await s.req(`/api/admin/llm/providers/${providerId}/update`, { cookie: admin, json: { enabled: false } })
    assert.equal((await s.req('/api/models', { cookie: user })).json.models.length, 0)
  } finally { await s.close(); up.close() }
})

test('改端点地址必须重新填 Key，并且要输管理员密码（被盗的会话不能把已存的 Key 发到别处）', async () => {
  const up = await mockUpstream()
  const s = await startServer({ ALLOW_PRIVATE_LLM_HOSTS: '1' })
  try {
    const admin = await setupAdmin(s)
    const { providerId } = await addProvider(s, admin, { base_url: up.base + '/v1', api_key: 'sk-good-key-123456', models: ['deepseek-flash'] })
    // 用已存的 Key 获取列表：同一地址可以
    const same = await s.req('/api/admin/llm/probe', { cookie: admin, json: { providerId, protocol: 'openai', base_url: up.base + '/v1' } })
    assert.equal(same.status, 200, same.text)
    // 换地址就不会带上已存的 Key
    up.seen.length = 0
    const other = await s.req('/api/admin/llm/probe', { cookie: admin, json: { providerId, protocol: 'openai', base_url: up.base + '/evil' } })
    assert.equal(other.status, 400)
    assert.equal(other.json.error, 'key_required')
    assert.equal(up.seen.length, 0)
    // 修改地址：没密码不行，有密码但没新 Key 也不行
    assert.equal((await s.req(`/api/admin/llm/providers/${providerId}/update`, { cookie: admin, json: { base_url: up.base + '/evil' } })).status, 403)
    const noKey = await s.req(`/api/admin/llm/providers/${providerId}/update`, { cookie: admin, json: { base_url: up.base + '/evil', password: ADMIN.password } })
    assert.equal(noKey.json.error, 'key_required')
    // 换协议也算换地址
    const proto = await s.req(`/api/admin/llm/providers/${providerId}/update`, { cookie: admin, json: { protocol: 'anthropic', password: ADMIN.password } })
    assert.equal(proto.json.error, 'key_required')
    // 只改名字、开关不需要密码
    assert.equal((await s.req(`/api/admin/llm/providers/${providerId}/update`, { cookie: admin, json: { name: '新名字' } })).status, 200)
    // 带新 Key 和密码可以改
    const ok = await s.req(`/api/admin/llm/providers/${providerId}/update`, { cookie: admin, json: { base_url: up.base + '/v2', api_key: 'sk-another-key-9999', password: ADMIN.password } })
    assert.equal(ok.status, 200, ok.text)
    const view = await s.req('/api/admin/llm', { cookie: admin })
    assert.equal(view.json.providers[0].base_url, up.base + '/v2')
    assert.equal(view.json.providers[0].keyHint, '9999')
  } finally { await s.close(); up.close() }
})

test('默认不能拿服务器去访问内网、本机、云元数据地址（获取列表和转发都拦截）', async () => {
  const up = await mockUpstream()
  const s = await startServer()
  try {
    const admin = await setupAdmin(s)
    const port = new URL(up.base).port
    const targets = [
      `https://127.0.0.1:${port}/v1`, `https://localhost:${port}/v1`, 'https://169.254.169.254/latest', 'https://10.0.0.1/v1',
      'https://192.168.1.1/v1', 'https://[::1]/v1', 'https://[::ffff:127.0.0.1]/v1', 'https://0.0.0.0/v1', 'https://100.100.100.200/v1',
      `http://api.example.com/v1`, 'file:///etc/passwd', 'gopher://127.0.0.1/', 'https://user:pw@api.example.com/v1',
    ]
    for (const t of targets) {
      const r = await s.req('/api/admin/llm/probe', { cookie: admin, json: { protocol: 'openai', base_url: t, api_key: 'sk-good-key-123456' } })
      assert.equal(r.status, 400, `${t} → ${r.status} ${r.text}`)
      const c = await s.req('/api/admin/llm/providers', { cookie: admin, json: { protocol: 'openai', base_url: t, api_key: 'k', models: ['m'], password: ADMIN.password } })
      assert.equal(c.status, 400, `create ${t} → ${c.status}`)
    }
    assert.equal(up.seen.length, 0, '假服务一次都不应该被访问到')
    // 已保存的服务商，域名后来解析到内网（DNS 重绑定）：转发时也会被拦下
    s.ctx.db.prepare("INSERT INTO llm_providers (id, name, protocol, base_url, enabled, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', 'x', 'openai', ?, 1, 0, 0)").run(`https://localhost:${port}/v1`)
    s.ctx.db.prepare("INSERT INTO llm_models (id, provider_id, model, name, max_tokens, created_at) VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'm', 'm', 1000, 0)").run()
    const r = await s.req('/api/llm', { cookie: admin, json: { profileId: '22222222-2222-4222-8222-222222222222', body: { messages: [{ role: 'user', content: 'x' }] } } })
    assert.equal(r.json.status, 0)
    assert.match(r.json.body, /不被允许/)
    assert.equal(up.seen.length, 0)
  } finally { await s.close(); up.close() }
})

test('IP 判断', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '224.0.0.1', 'not-an-ip']) {
    assert.equal(isBlockedIp(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) assert.equal(isBlockedIp(ip), false, ip)
})

test('上游重定向不跟随；Anthropic 协议用 x-api-key 获取列表', async () => {
  const up = await mockUpstream()
  const s = await startServer({ ALLOW_PRIVATE_LLM_HOSTS: '1' })
  try {
    const admin = await setupAdmin(s)
    const anth = await s.req('/api/admin/llm/probe', { cookie: admin, json: { protocol: 'anthropic', base_url: up.base + '/anth', api_key: 'sk-good-key-123456' } })
    assert.equal(anth.status, 200, anth.text)
    assert.deepEqual(anth.json.models, [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }])
    assert.equal(up.seen.at(-1)!.headers['anthropic-version'], '2023-06-01')
    assert.equal(up.seen.at(-1)!.headers.authorization, undefined)

    const { models } = await addProvider(s, admin, { base_url: up.base + '/redirect', api_key: 'sk-good-key-123456', models: ['x'] })
    const count = up.seen.length
    const r = await s.req('/api/llm', { cookie: admin, json: { profileId: models[0].id, body: { messages: [{ role: 'user', content: 'x' }] } } })
    assert.equal(r.json.status, 302)
    assert.equal(up.seen.length, count + 1, '只请求一次，不跟随跳转')
  } finally { await s.close(); up.close() }
})

test('模型名、模型设置的输入校验；每日次数上限', async () => {
  const up = await mockUpstream()
  const s = await startServer({ ALLOW_PRIVATE_LLM_HOSTS: '1', LLM_DAILY_LIMIT: '2' })
  try {
    const admin = await setupAdmin(s)
    const { providerId, models } = await addProvider(s, admin, { base_url: up.base + '/v1', api_key: 'sk-good-key-123456', models: ['deepseek-flash'] })
    assert.equal((await s.req(`/api/admin/llm/providers/${providerId}/models`, { cookie: admin, json: { models: ['bad\nname'] } })).status, 400)
    assert.equal((await s.req(`/api/admin/llm/providers/${providerId}/models`, { cookie: admin, json: { models: [] } })).status, 400)
    // 重复添加会被忽略
    assert.equal((await s.req(`/api/admin/llm/providers/${providerId}/models`, { cookie: admin, json: { models: ['deepseek-flash', 'manual-model'] } })).json.added, 1)
    const id = models[0].id
    assert.equal((await s.req(`/api/admin/llm/models/${id}/update`, { cookie: admin, json: { max_tokens: 10 } })).status, 400)
    assert.equal((await s.req(`/api/admin/llm/models/${id}/update`, { cookie: admin, json: { enabled: 'yes' } })).status, 400)
    assert.equal((await s.req(`/api/admin/llm/models/${id}/update`, { cookie: admin, json: { routes: ['quiz', 'evil'], max_tokens: 4096, supports_vision: true } })).status, 200)
    const m = (await s.req('/api/models', { cookie: admin })).json.models.find((x: { id: string }) => x.id === id)
    assert.deepEqual(m.routes, ['quiz'])
    assert.equal(m.max_tokens, 4096)
    const call = () => s.req('/api/llm', { cookie: admin, json: { profileId: id, body: { messages: [{ role: 'user', content: 'x' }] } } })
    assert.equal((await call()).status, 200)
    assert.equal((await call()).status, 200)
    const over = await call()
    assert.equal(over.status, 429)
    assert.equal(over.json.error, 'quota')
    // 删除服务商连带删除模型
    await s.req(`/api/admin/llm/providers/${providerId}/delete`, { cookie: admin, json: {} })
    assert.equal((s.ctx.db.prepare('SELECT COUNT(*) AS n FROM llm_models').get() as { n: number }).n, 0)
  } finally { await s.close(); up.close() }
})
