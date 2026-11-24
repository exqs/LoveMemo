/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// Tauri 期望固定端口；TAURI_ENV_* 变量由 tauri cli 注入
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: { target: 'chrome105', sourcemap: false },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
