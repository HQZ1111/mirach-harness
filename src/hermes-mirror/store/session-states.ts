/** 会话状态表（hermes `store/session-states.ts` 的最小对偶）。 */
import { atom } from 'nanostores'

/** 存储会话 id → 状态（`'running'` / `'idle'` / …）。 */
export const $sessionStates = atom<Record<string, string>>({})
