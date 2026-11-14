/**
 * `@/api/toolsets` shim — the toolset read/write pair.
 *
 * Upstream a REST wrapper (GET /api/tools/toolsets, PUT …/:name). The host's
 * toolsets are `pi_capabilities`' projection of pi's known tools into semantic
 * groups (see src-tauri/src/pi_capabilities.rs), toggled through
 * `pi_set_toolset_enabled` → `SessionOptions.enabled_tools`.
 *
 * Shapes are upstream's so the mirrored tabs need no edits. Delegates to
 * `hermes.ts`, which owns the row mapping (pi `key` → upstream `name`).
 */

import { getToolsets as getMapped, setToolsetEnabled as setMapped } from '@/hermes-shim/hermes'

export async function getToolsets(profile?: import('@/hermes-shim/api/client').ProfileScope) {
  return getMapped(profile)
}

export async function setToolsetEnabled(
  name: string,
  enabled: boolean,
  profile?: import('@/hermes-shim/api/client').ProfileScope
) {
  return setMapped(name, enabled, profile)
}
