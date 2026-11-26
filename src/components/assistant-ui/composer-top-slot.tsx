import { useMemo } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'

import { Slot as ContribSlot } from '@/hermes-shim/contrib/react/slot'
import { ComposerSessionProvider } from '@/hermes-shim/app/composer-session'
import { COMPOSER_TOP_AREA } from '@/hermes-shim/contrib/composer-middleware'
import { queryClient } from '@/hermes-shim/lib/query-client'

/**
 * 上游 `app/chat/composer/composer-top-slot.tsx` 的宿主对偶：
 * `composer.top` banner 槽位 + 它属于哪个会话。
 *
 * 上游用 `$sessionStates` 把运行期 id 映射到落盘 id；宿主 thread id 就是
 * 落盘 id（sessionCatalog 以会话文件 id 为键），映射为恒等——语义不变。
 *
 * **必须挂 QueryClientProvider**（2026-11-25 实测）：插件贡献（hermes-bots
 * 的 teammate-waits）用 TanStack Query 的 `useQuery`；宿主应用根没有全局
 * Provider，缺这层会每次渲染报 `No QueryClient set` 并隐藏该贡献。
 * 与 capabilities / cron / plugin 面板同一做法（各自包 Provider）。
 */
export function ComposerTopSlot({ sessionId: id }: { sessionId?: null | string }) {
  const sessionId = id ?? null

  const value = useMemo(() => ({ sessionId, storedSessionId: sessionId }), [sessionId])

  return (
    <QueryClientProvider client={queryClient}>
      <ComposerSessionProvider value={value}>
        <ContribSlot area={COMPOSER_TOP_AREA} />
      </ComposerSessionProvider>
    </QueryClientProvider>
  )
}
