/** 键位提示 hook（hermes `lib/keybinds/use-keybind-hint.ts` 的最小对偶）。 */
import { useEffect, useState } from 'react'

import { comboFromEvent, comboLabel, type KeyCombo } from './combo'

export function useKeybindHint(target?: KeyCombo): string {
  const [label, setLabel] = useState(() => (target ? comboLabel(target) : ''))
  useEffect(() => {
    if (!target) return
    setLabel(comboLabel(target))
  }, [target])
  return label
}

/** 监听下一个按键组合（用于「按下快捷键」录制 UI）。 */
export function useKeyCapture(enabled: boolean, onCapture: (combo: KeyCombo) => void): void {
  useEffect(() => {
    if (!enabled) return
    const listener = (event: KeyboardEvent) => {
      event.preventDefault()
      onCapture(comboFromEvent(event))
    }
    window.addEventListener('keydown', listener, true)
    return () => window.removeEventListener('keydown', listener, true)
  }, [enabled, onCapture])
}
