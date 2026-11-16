import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// mirach-harness：布局骨架试验田（flexlayout-react 路线）。
// 端口用 1430，避免和主工程 MIRACH 的 1420 dev server 撞车。

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // hermes 插件 SDK 的宿主对偶（见 src/sdk/index.ts 头注释）。
      // 2026-11-16：sdk-upstream 是上游 SDK 逐字副本，但它 import 的
      // `@/store/*` / `@/hermes` 在本仓不存在——alias 指过去会让整棵插件图
      // 在 vite 里解析失败。宿主用 curated shim（sdk/index.ts）作为唯一 SDK 面。
      '@hermes/plugin-sdk': fileURLToPath(new URL('./src/sdk/index.ts', import.meta.url)),
      '@hermes/shared': fileURLToPath(new URL('./src/shared/index.ts', import.meta.url))
    }
  },
  server: {
    host: '127.0.0.1',
    port: 1430,
    strictPort: true,
    // src-tauri 的编译产物（target/**）不归前端 watcher 管——cargo 链接
    // 锁住 mirach_harness.exe 时 chokidar 会 EBUSY 整个 vite 死掉
    // （规矩 8 的 tauri dev 形态），tauri dev 的 Rust 重编由 CLI 自己管。
    // crates/** 同理：N1 的 agent-protocol 有自己的 target/**，cargo 锁
    // build_script_build-*.exe 时同样 EBUSY 杀死 vite（2026-10-14 实锤）。
    watch: {
      ignored: ['**/src-tauri/**', '**/crates/**']
    }
  }
})
