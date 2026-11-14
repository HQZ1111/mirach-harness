/**
 * hermes 桌面端 `hooks/use-delayed-true.ts` 的逐字移植。
 *
 * `active` 连续为真超过 `delayMs` 才返回 true；`active` 一假立刻回落 false。
 * 用来给加载骨架加门槛：快操作不闪骨架（界面在不可感知的延迟窗口内保持
 * 空白），只有真正慢的加载才出现骨架。
 */

import { useEffect, useState } from 'react'

export function useDelayedTrue(active: boolean, delayMs = 180): boolean {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    if (!active) {
      setShown(false)

      return
    }

    const id = window.setTimeout(() => setShown(true), delayMs)

    return () => window.clearTimeout(id)
  }, [active, delayMs])

  return shown
}
