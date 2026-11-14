/**
 * @/store/windows shim - main vs secondary window.
 *
 * Upstream spawns secondary windows (quick entry, HUD, popouts) and owns the
 * window-relay protocol between them (window.open sessions routed through
 * Electron). The host has one main window plus a settings window (which does not
 * mount the capabilities page), so both predicates are false and the relay
 * surface is absent - which every caller already treats as "single window".
 */

export function isBrowserWindow(): boolean {
  return false
}

export function isSecondaryWindow(): boolean {
  return false
}

/** Upstream mounts the HUD as its own window kind. The host's ?win=hud branch is
 *  not wired (AGENTS.md: main.tsx keeps three branches, hud not implemented), so
 *  no window is ever the HUD. */
export function isHudWindow(): boolean {
  return false
}
