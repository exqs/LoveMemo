// 服务端入口：node server/src/main.ts
import { loadConfig } from './config.ts'
import { createContext, createHttpServer, prepareSetupCode } from './app.ts'
import { usableModels } from './providers.ts'

// 新建的文件只有本用户可读写（数据库、加密数据文件）
process.umask(0o077)

let cfg
try { cfg = loadConfig() } catch (e) {
  console.error(`[config] ${(e as Error).message}`)
  process.exit(1)
}

if (cfg.plainHttp) {
  console.warn([
    '',
    '!!!!!!!!!!!!!!!! 注意：现在是 http 访问（不加密） !!!!!!!!!!!!!!!!',
    `对外地址 ${cfg.publicOrigin}`,
    '密码、登录凭证、聊天记录和管理员填写的 API Key 在网络上都是明文传输，',
    '同一个 Wi-Fi、运营商或中间任何一台设备都能看到甚至篡改。',
    '只适合内网或临时测试。要放到公网长期用，请改成 https（见 deploy/DEPLOY.md）。',
    '!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!',
    '',
  ].join('\n'))
}

const ctx = await createContext(cfg)
const code = prepareSetupCode(ctx)
if (code) {
  // 只在还没有任何用户时出现；创建管理员后立即作废
  console.log([
    '',
    '================ 首次安装 ================',
    `打开 ${cfg.publicOrigin} ，用下面的安装码创建超级管理员：`,
    '',
    `    ${code}`,
    '',
    '安装码只在本次启动有效，重启服务会换一个新的。',
    '==========================================',
    '',
  ].join('\n'))
}

const server = createHttpServer(ctx)
server.listen(cfg.port, cfg.host, () => {
  console.log(`[server] LoveMemo 已启动：监听 ${cfg.host}:${cfg.port}，对外地址 ${cfg.publicOrigin}，已开启模型 ${usableModels(ctx).length} 个${cfg.allowPrivateLlm ? '（允许内网模型地址）' : ''}`)
})

function shutdown() {
  server.close(() => { ctx.db.close(); process.exit(0) })
  setTimeout(() => process.exit(0), 10_000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
