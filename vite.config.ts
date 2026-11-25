/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Tauri 期望固定端口；TAURI_ENV_* 变量由 tauri cli 注入
// 开发时 /api 转发到本机服务端（npm run server:dev），保持同源，和线上一样走 Cookie
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } } },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  // 正式构建不带示例数据（里面是真实聊天转写），见 src/env.d.ts
  define: { __PREVIEW_BUILD__: 'false' },
  build: { target: 'chrome105', sourcemap: false },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
