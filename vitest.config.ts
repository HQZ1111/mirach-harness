import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    // 宿主用例（排除镜像/适配层两个目录）+ **hermes-mirror/app/cron 的四个
    // 纯逻辑用例**（2026-10-29）。
    //
    // 为什么给 cron 开这个口子：定时任务页是从上游逐字复制来的，这两个测试
    // 验证纯函数（调度摘要 `job-state`、编辑器校验 `cron-job-model`），
    // 不碰 DOM、不碰上游 atom——纳入门禁让"照抄的语义"有回归保护。
    //
    // **排除的两个**（各有明确原因，不是"跑不过就不跑"）：
    //  - `cron-actions.test.ts`：上游用例 mock 的是 `@/api/client` 的
    //    `getApiRequestConnection` 连接作用域，并在模块顶层摸 `window`
    //    （上游 vitest 是 jsdom 环境）。宿主的 `getApiRequestConnection`
    //    恒 null（唯一引擎），没有连接作用域可测——那组用例验证的是
    //    "多连接下 scope key 不串"，宿主不存在这个维度。
    //  - `open-cron-run.test.ts`：测 `refreshCronRunWriteGate`，它读写上游
    //    `$sessions` / `$cronSessions` atom 并走 gateway RPC 往返。宿主的
    //    会话行在 `sessionCatalog`（zustand），没有那两个 atom；且宿主 cron
    //    run 的只读判定走 `read-only-transcript` 的 verdict 表，不经过
    //    gateway。搬过来只能靠造假 atom 让它变绿，那是掩盖而非验证。
    include: [
      'src/components/**/*.test.ts',
      'src/components/**/*.test.tsx',
      'src/lib/**/*.test.ts',
      'src/lib/**/*.test.tsx',
      'src/app/**/*.test.ts',
      'src/app/**/*.test.tsx',
      'src/store/**/*.test.ts',
      'src/store/**/*.test.tsx',
      'src/i18n/**/*.test.ts',
      'src/i18n/**/*.test.tsx',
      'src/hooks/**/*.test.ts',
      'src/hooks/**/*.test.tsx',
      'src/ipc/**/*.test.ts',
      'src/test/**/*.test.ts',
      'src/hermes-mirror/app/cron/job-state.test.ts',
      'src/hermes-mirror/app/cron/cron-job-model.test.ts',
    ],
    exclude: ['node_modules/**'],
  },
})
