import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// mirach-harness：布局骨架试验田（flexlayout-react 路线）。
// 端口用 1430，避免和主工程 MIRACH 的 1420 dev server 撞车。

const root = fileURLToPath(new URL('.', import.meta.url))

// emojibase 资源（hermes vite.config.ts `hermes:emojibase-assets` 的同款移植，
// 2026-11-28 为表情反应/`:shortcode:` 补全移植）：frimousse 的 emoji picker
// 运行期抓 `<emojibaseUrl>/<locale>/data.json`，默认指向 CDN——桌面端必须
// 离线可用，所以把随包的 emojibase-data 挂在稳定本地路径：dev 走中间件，
// build 出资产。只发一个 locale 实际需要的三个文件（zh 界面 + en 兜底）。
const emojibaseDir = path.resolve(root, 'node_modules/emojibase-data')
const EMOJIBASE_PATH = /^[a-z-]+\/(data|messages|shortcodes\/emojibase)\.json$/

const emojibaseAssets = () => ({
  name: 'mirach:emojibase-assets',
  configureServer(server: {
    middlewares: {
      use: (
        route: string,
        handler: (req: { url?: string }, res: unknown, next: () => void) => void,
      ) => void
    }
  }) {
    server.middlewares.use('/emojibase', (req, res, next) => {
      const rel = (req.url ?? '').split('?')[0]!.replace(/^\/+/, '')
      if (!EMOJIBASE_PATH.test(rel)) return next()
      fs.readFile(path.join(emojibaseDir, rel), (err, buf) => {
        if (err) return next()
        const r = res as {
          setHeader: (k: string, v: string) => void
          end: (b: Buffer) => void
        }
        r.setHeader('Content-Type', 'application/json')
        r.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        r.end(buf)
      })
    })
  },
  generateBundle(this: { emitFile: (asset: { type: 'asset'; fileName: string; source: Buffer }) => void }) {
    for (const rel of [
      'zh/data.json',
      'zh/messages.json',
      'zh/shortcodes/emojibase.json',
      'en/data.json',
      'en/messages.json',
      'en/shortcodes/emojibase.json',
    ]) {
      this.emitFile({
        type: 'asset',
        fileName: `emojibase/${rel}`,
        source: fs.readFileSync(path.join(emojibaseDir, rel)),
      })
    }
  },
})

export default defineConfig({
  plugins: [react(), tailwindcss(), emojibaseAssets()],
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
