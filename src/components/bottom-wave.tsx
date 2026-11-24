import { useStore } from 'zustand'

import { appearanceStore } from '@/lib/appearance-prefs'

/**
 * 外观 →「底部动效」：窗口底部向上的一层弧形波浪渐变，颜色跟随主题色
 * （`--brand`）。纯装饰，pointer-events:none，不拦任何操作。
 */
export function BottomWave() {
  const on = useStore(appearanceStore, (s) => s.bottomWave)
  if (!on) return null

  return (
    <div aria-hidden className="mirach-bottom-wave">
      <div className="mirach-bottom-wave-layer mirach-bottom-wave-layer-a" />
      <div className="mirach-bottom-wave-layer mirach-bottom-wave-layer-b" />
    </div>
  )
}
