/** 会话颜色覆盖（hermes `store/session-color.ts` 的最小对偶）。 */
import { atom } from 'nanostores'

/** 存储会话 id → 颜色覆盖。 */
export const $sessionColorOverrides = atom<Record<string, string>>({})

/** 设置某会话的颜色覆盖。 */
export function setSessionColorOverride(storedSessionId: string, color: null | string): void {
  const current = { ...$sessionColorOverrides.get() }
  if (color) current[storedSessionId] = color
  else delete current[storedSessionId]
  $sessionColorOverrides.set(current)
}
