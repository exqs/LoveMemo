// 服务端入口：node server/src/main.ts
import { loadConfig } from './config.ts'
import { createContext, createHttpServer, prepareSetupCode } from './app.ts'

// 新建的文件只有本用户可读写（数据库、加密数据文件）
process.umask(0o077)

let cfg
try { cfg = loadConfig() } catch (e) {
  console.error(`[config] ${(e as Error).message}`)
  process.exit(1)
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
  console.log(`[server] LoveMemo 已启动：监听 ${cfg.host}:${cfg.port}，对外地址 ${cfg.publicOrigin}，可用模型 ${ctx.models.list.filter((m) => m.available).length} 个`)
})

function shutdown() {
  server.close(() => { ctx.db.close(); process.exit(0) })
  setTimeout(() => process.exit(0), 10_000).unref()
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
