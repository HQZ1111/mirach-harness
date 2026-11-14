/**
 * @/store/haptics shim - the haptics mute flag.
 *
 * Upstream a per-device mute persisted through the backend settings. The host
 * stores it locally; the flag shape is what lib/haptics reads.
 */

import { atom } from 'nanostores'

export const $hapticsMuted = atom(false)

export function setHapticsMuted(muted: boolean): void {
  $hapticsMuted.set(muted)
}
