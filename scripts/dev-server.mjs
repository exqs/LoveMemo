// 本机开发用：在 .dev-data/ 里放开发数据和一把开发专用密钥，然后启动服务端。
// 配合 `npm run dev`（Vite 把 /api 转发到这里）在 http://localhost:1420 打开。
// 只监听 127.0.0.1，不能用于部署；部署请看 deploy/DEPLOY.md。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

const dir = resolve('.dev-data')
mkdirSync(dir, { recursive: true, mode: 0o700 })
const keyFile = resolve(dir, 'dev.key')
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('base64'), { mode: 0o600 })
const modelsFile = existsSync('deploy/models.json') ? 'deploy/models.json' : 'deploy/models.example.json'

const child = spawn(process.execPath, ['server/src/main.ts'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: '8787',
    PUBLIC_ORIGIN: 'http://localhost:1420',
    DATA_DIR: resolve(dir, 'data'),
    DATA_KEY: readFileSync(keyFile, 'utf8').trim(),
    MODELS_FILE: resolve(modelsFile),
    STATIC_DIR: resolve('dist'),
  },
})
child.on('exit', (code) => process.exit(code ?? 0))
