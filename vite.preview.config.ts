// 界面预览构建：打成一个 JS + 一个 CSS，wasm 内联成 base64，再由 scripts/make-preview.mjs 拼成单文件 HTML。
// 只用于在没有 Tauri 的环境里查看界面，不参与桌面版打包。
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 预览面板的安全策略不允许 WebAssembly，改用 sql.js 的纯 JavaScript 版本（接口相同）
  resolve: { alias: [{ find: /^sql\.js$/, replacement: 'sql.js/dist/sql-asm.js' }] },
  build: {
    outDir: 'dist-preview',
    target: 'chrome105',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    rolldownOptions: { output: { codeSplitting: false } },
  },
})
