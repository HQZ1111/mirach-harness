/**
 * @/store/free-tier shim - the hosted subscription tier.
 *
 * Upstream derives it from the sign-in/challenge stores and the interface mode.
 * Host: no subscription, no guest identity, no hosted connectors, so the status
 * is a constant "not available". Upstream field names are kept because the
 * connectors page reads has_guest; false there is the truth.
 */

import { atom } from 'nanostores'

export interface FreeTierStatus {
  available: boolean
  has_guest: boolean
  signed_in: boolean
}

/** Never available on this host: pi is a local engine with no hosted offering. */
export const $freeTierStatus = atom<FreeTierStatus>({
  available: false,
  has_guest: false,
  signed_in: false
})

/** Upstream's managed free-tier model id, copied verbatim (`store/free-tier.ts`).
 *  It is upstream's own literal, not a host invention: the billing view renders
 *  it only when the backend reports `status: 'free_tier'`, and this host has no
 *  billing backend at all (the settings page does not mount the billing tab —
 *  see AGENTS.md「账户页」: no cloud subscription, so the plan/usage blocks are
 *  not rendered). Typed `string` like upstream so the mirrored view typechecks. */
export const FREE_TIER_MODEL = 'nous/welcome'
