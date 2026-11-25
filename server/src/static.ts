// 前端静态文件。只读 STATIC_DIR 里的文件，拒绝 ../、隐藏文件、符号链接逃逸
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, join, normalize, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
}

export function staticHandler(rootDir: string) {
  let root: string | null = null
  async function resolveFile(pathname: string): Promise<string | null> {
    root ??= await realpath(rootDir).catch(() => null)
    if (!root) return null
    let p: string
    try { p = decodeURIComponent(pathname) } catch { return null }
    if (p.includes('\0') || p.includes('\\')) return null
    if (p.split('/').some((seg) => seg.startsWith('.'))) return null
    const full = normalize(join(root, p))
    if (full !== root && !full.startsWith(root + sep)) return null
    const real = await realpath(full).catch(() => null)
    if (!real || (real !== root && !real.startsWith(root + sep))) return null
    const st = await stat(real).catch(() => null)
    return st?.isFile() ? real : null
  }

  return async function serve(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    let file = pathname === '/' ? await resolveFile('/index.html') : await resolveFile(pathname)
    // 页面用 HashRouter，没有扩展名的路径都回到首页
    if (!file && !extname(pathname)) file = await resolveFile('/index.html')
    if (!file) return false
    const type = TYPES[extname(file).toLowerCase()]
    if (!type) return false
    res.statusCode = 200
    res.setHeader('Content-Type', type)
    // 带哈希的打包文件可以长期缓存；index.html 每次都要重新取，保证更新后立刻生效
    res.setHeader('Cache-Control', file.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache')
    if (req.method === 'HEAD') { res.end(); return true }
    await new Promise<void>((resolve) => {
      const s = createReadStream(file)
      s.on('error', () => { if (!res.headersSent) res.statusCode = 500; res.end(); resolve() })
      s.on('end', () => resolve())
      s.pipe(res)
    })
    return true
  }
}
