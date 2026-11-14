/**
 * `window.hermesDesktop` installation.
 *
 * Split from `bridge.ts` so the route table stays about data and this file stays
 * about the single global object. Members the host can implement are set; the
 * rest are left undefined, which every mirrored call site already treats as
 * "not available" (they all go through optional chaining).
 */

export function installBridge(bridge: NonNullable<Window['hermesDesktop']>): void {
  window.hermesDesktop = bridge
}
