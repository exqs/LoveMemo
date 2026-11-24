// 把 dist-preview 里的 JS/CSS 内联进 HTML，每个页面一个文件，用于离线查看界面。
// 用法：npx vite build -c vite.preview.config.ts && node scripts/make-preview.mjs <输出目录>
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? 'preview'
const dir = 'dist-preview/assets'
const files = readdirSync(dir)
const js = readFileSync(join(dir, files.find((f) => f.endsWith('.js'))), 'utf8').replace(/<\/script/gi, '<\\/script')
const css = readFileSync(join(dir, files.find((f) => f.endsWith('.css'))), 'utf8')

// [文件名, 路由, 加载后自动执行的操作（按文字点按钮）]
const pages = [
  ['01-今天', '/', []],
  ['02-便签', '/incidents', []],
  ['03-聊天编辑', '/incident/inc-1122/edit', []],
  ['04-复盘', '/incident/inc-1122', []],
  ['05-知识库', '/rules', []],
  ['06-知识点详情', '/rule/r2', []],
  ['07-复习-回忆卡', '/review', ['想好了，翻面']],
  ['08-复习-练习题', '/review', ['想好了，翻面', '做练习题']],
  ['09-承诺', '/commitments', []],
  ['10-统计-词云', '/stats', []],
  ['11-统计-图谱', '/stats', ['问题图谱']],
  ['12-设置', '/settings', []],
  ['13-记一次', '/new', []],
]

mkdirSync(out, { recursive: true })
for (const [name, route, clicks] of pages) {
  const width = Number(process.env.PREVIEW_WIDTH || 0)
  // 预览面板没有控制台：把错误显示在页面上；可选按桌面宽度缩放
  const errBox = `const E=(m)=>{let d=document.getElementById('__err');if(!d){d=document.createElement('pre');d.id='__err';d.style.cssText='position:fixed;left:0;right:0;bottom:0;max-height:45%;overflow:auto;background:#c8412f;color:#fff;font:12px monospace;padding:8px;z-index:99999;white-space:pre-wrap;margin:0';(document.body||document.documentElement).appendChild(d)}d.textContent+=m+'\\n'};` +
    `addEventListener('error',e=>E('error: '+(e.message||e)+' '+(e.error&&e.error.stack||'')));addEventListener('unhandledrejection',e=>E('rejection: '+(e.reason&&(e.reason.stack||e.reason.message)||e.reason)));` +
    `const ce=console.error.bind(console);console.error=(...a)=>{ce(...a);E('console.error: '+a.map(x=>x&&x.stack||String(x)).join(' '))};`
  const zoom = width ? `const Z=()=>{document.documentElement.style.zoom=String(Math.min(1,innerWidth/${width}))};Z();addEventListener('resize',Z);` : ''
  const boot = errBox + zoom + `window.__FUPAN_PREVIEW__='1';location.hash='#${route}';` +
    `(async()=>{const w=(ms)=>new Promise(r=>setTimeout(r,ms));await w(1800);for(const t of ${JSON.stringify(clicks)}){` +
    `const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim().startsWith(t));if(b)b.click();await w(1400)}})();`
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>复盘便签 · ${name}</title>` +
    `<style>${css}</style><script>${boot}</script></head><body><div id="root"></div><script type="module">${js}</script></body></html>`
  writeFileSync(join(out, `${name}.html`), html)
}
console.log(`wrote ${pages.length} pages to ${out}`)
