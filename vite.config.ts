import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// mirach-harness：布局骨架试验田（flexlayout-react 路线）。
// 端口用 1430，避免和主工程 MIRACH 的 1420 dev server 撞车。

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: '127.0.0.1',
    port: 1430,
    strictPort: true,
    // src-tauri 的编译产物（target/**）不归前端 watcher 管——cargo 链接
    // 锁住 mirach_harness.exe 时 chokidar 会 EBUSY 整个 vite 死掉
    // （规矩 8 的 tauri dev 形态），tauri dev 的 Rust 重编由 CLI 自己管。
    watch: {
      ignored: ['**/src-tauri/**']
    }
  }
})
