/**
 * @/store/free-tier-sign-in shim - the hosted-tier sign-in flow.
 *
 * Upstream: opens the Nous account sign-in window and tracks the completed-turn
 * counter that re-reads the connector list after an agent-side connect.
 *
 * Host: no hosted tier, so there is no sign-in to open and no turn counter that
 * would change anything. openFreeTierSignIn says so instead of opening a dead
 * window; the atoms stay so the connectors page can read "nothing pending".
 */

import { atom } from 'nanostores'

/** Nothing to re-read after a turn: the connector list is local config. */
export const $freeTierTurnCompleted = atom(0)

/** Called when an agent-side connect finishes. Deliberately empty: the host has
 *  no hosted tier, so a completed turn cannot change what the page shows. */
export function noteFreeTierAppConnected(): void {}

/** Upstream opens a sign-in window. This host has no account system. */
export function openFreeTierSignIn(): void {
  console.warn('[free-tier] 本宿主没有订阅账户体系，无法打开登录窗口')
}
