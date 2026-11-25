// 服务器命令行工具，只能在服务器上执行（需要能登录服务器并进入容器），网页和接口里没有对应入口。
//
//   docker compose exec -it app node server/src/cli.ts reset-admin-password
//
// 唯一用途：超级管理员忘记密码时重设。只能改超级管理员本人，不能改普通用户的密码，
// 执行后超级管理员的所有登录全部失效，并写入安全日志。
import { loadConfig } from './config.ts'
import { audit, openDb, tx, type UserRow } from './db.ts'
import { hashPassword } from './crypto.ts'
import { checkPassword } from './auth.ts'
import { HttpError } from './http.ts'

function askHidden(q: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    if (!stdin.isTTY) { reject(new Error('需要在交互式终端里运行（docker compose exec -it ...）')); return }
    process.stdout.write(q)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let s = ''
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stdout.write('\n'); resolve(s); return }
        if (c === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130) }
        if (c === '\u007f' || c === '\b') s = s.slice(0, -1)
        else s += c
      }
    }
    stdin.on('data', onData)
  })
}

const cmd = process.argv[2]
if (cmd !== 'reset-admin-password') {
  console.log('用法：node server/src/cli.ts reset-admin-password')
  process.exit(cmd ? 1 : 0)
}

process.umask(0o077)
const cfg = loadConfig()
const db = openDb(cfg.dataDir)
const admin = db.prepare("SELECT * FROM users WHERE role = 'superadmin'").get() as UserRow | undefined
if (!admin) { console.log('还没有超级管理员，直接打开网页初始化即可。'); process.exit(1) }
console.log(`将重设超级管理员「${admin.username}」的密码。`)
const pw = await askHidden('新密码：')
const pw2 = await askHidden('再输一次：')
if (pw !== pw2) { console.log('两次输入不一致，已取消。'); process.exit(1) }
try { checkPassword(pw, admin.username_norm) } catch (e) {
  console.log(e instanceof HttpError ? e.message : String(e)); process.exit(1)
}
const hash = await hashPassword(pw, cfg.scryptLogN)
tx(db, () => {
  db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ?, disabled = 0 WHERE id = ?').run(hash, Date.now(), admin.id)
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(admin.id)
  const pairPrefix = `p:${admin.username_norm}|`
  db.prepare('DELETE FROM login_throttle WHERE key = ? OR substr(key, 1, ?) = ?').run(`g:${admin.username_norm}`, pairPrefix.length, pairPrefix)
  audit(db, 'admin_password_reset_cli', { userId: admin.id, username: admin.username, ip: 'cli' })
})
console.log('已重设。所有设备上的管理员登录都已退出，请用新密码重新登录。')
db.close()
