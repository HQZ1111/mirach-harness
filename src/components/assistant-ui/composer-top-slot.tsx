import { useMemo } from 'react'

import { Slot as ContribSlot } from '@/hermes-shim/contrib/react/slot'
import { ComposerSessionProvider } from '@/hermes-shim/app/composer-session'
import { COMPOSER_TOP_AREA } from '@/hermes-shim/contrib/composer-middleware'

/**
 * 上游 `app/chat/composer/composer-top-slot.tsx` 的宿主对偶：
 * `composer.top` banner 槽位 + 它属于哪个会话。
 *
 * 上游用 `$sessionStates` 把运行期 id 映射到落盘 id；宿主 thread id 就是
 * 落盘 id（sessionCatalog 以会话文件 id 为键），映射为恒等——语义不变。
 */
export function ComposerTopSlot({ sessionId: id }: { sessionId?: null | string }) {
  const sessionId = id ?? null

  const value = useMemo(() => ({ sessionId, storedSessionId: sessionId }), [sessionId])

  return (
    <ComposerSessionProvider value={value}>
      <ContribSlot area={COMPOSER_TOP_AREA} />
    </ComposerSessionProvider>
  )
}
