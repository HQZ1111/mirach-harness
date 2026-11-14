/**
 * @/store/desktop-metrics shim - feature-use telemetry.
 *
 * Upstream a 1,000-line pipeline: batches feature-use and friction events, stamps
 * them with a machine profile and pane scope, ships them to the hermes backend's
 * metrics endpoint (shared_metrics.desktop_* RPCs, gated on the profile's consent
 * switch).
 *
 * Host: no metrics endpoint to ship to, so events are recorded in-memory only.
 * The type surface (ErrorToastCategory) is kept because the notification store's
 * error summaries are typed against it.
 *
 * NOT a silent drop: nothing here pretends to report. Telemetry that goes nowhere
 * is the honest state for an engine with no metrics backend; if one lands,
 * recordFeatureUse is the single write point to wire up.
 */

export type ErrorToastCategory =
  | 'api_key_missing'
  | 'api_key_rejected'
  | 'disk_full'
  | 'gateway_auth_failed'
  | 'method_not_allowed'
  | 'microphone_permission'
  | 'other'
  | 'restart_required'
  | 'rpc_out_of_sync'
  | 'storage_failure'
  | 'timeout'
  | 'unclassified'

export interface FeatureUseEvent {
  at: number
  detail?: string
  feature: string
}

export interface FrictionEvent {
  at: number
  category: ErrorToastCategory
  kind: 'error_toast'
}

const featureUses: FeatureUseEvent[] = []
const frictions: FrictionEvent[] = []

/** In-memory ring (last 200 of each). Nothing ships; see header. */
export function recordFeatureUse(feature: string, detail?: string): void {
  featureUses.push({ at: Date.now(), detail, feature })
  if (featureUses.length > 200) featureUses.shift()
}

export function recordFriction(kind: 'error_toast', category: ErrorToastCategory): void {
  frictions.push({ at: Date.now(), category, kind })
  if (frictions.length > 200) frictions.shift()
}

/** Read back for tests / a future surface. */
export function bufferedEvents(): { featureUses: readonly FeatureUseEvent[]; frictions: readonly FrictionEvent[] } {
  return { featureUses: [...featureUses], frictions: [...frictions] }
}
