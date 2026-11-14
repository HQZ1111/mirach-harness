/**
 * @/store/connections shim - the multi-gateway registry.
 *
 * Upstream keeps registered gateways (local / remote / ssh / cloud) and the
 * active connection id the whole app routes through. pi is in-process: one
 * engine, no registry. null is the honest "local pool" value every caller already
 * handles (they all fall back to 'local').
 */

import { atom } from 'nanostores'

export const $activeConnectionId = atom<null | string>(null)
