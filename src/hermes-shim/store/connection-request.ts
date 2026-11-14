/**
 * @/store/connection-request shim - the connector/install card model.
 *
 * Upstream this store holds the in-flight connection.request operation for a
 * chat: the backend (hermes) emits targets, the renderer draws a card, the user
 * answers, the backend settles it. The capabilities page uses only the pure
 * part - the target parser and its type - for the hosted-connector directory.
 *
 * Host: pi has no hosted connectors and no connection.request event, so there is
 * no operation to hold. The parser reuses the SHARED wire types (the mirror
 * passes those exact payloads in) and keeps upstream's normalization.
 */

import type {
  ConnectionTargetAction,
  ConnectionTargetEnvField,
  ConnectionTargetKind,
  ConnectionTargetState,
  ConnectionOperationTarget
} from '@/hermes-mirror/shared'

import type { SetupField } from '@/hermes-shim/components/ui/setup-field-list'

export type {
  ConnectionTargetAction,
  ConnectionTargetEnvField,
  ConnectionTargetKind,
  ConnectionTargetState
}

export interface ConnectionTarget {
  action: ConnectionTargetAction
  alias?: null | string
  connectUrl: null | string
  connectionId: string
  detail: string
  discoveryError: null | string
  instructions: null | string
  kind: ConnectionTargetKind
  name: string
  requiredEnv: SetupField[]
  state: ConnectionTargetState
  tools: string[]
}

const envFields = (fields: ConnectionTargetEnvField[] | null | undefined): SetupField[] =>
  (fields ?? []).map(({ default: defaultValue, name, prompt, required, secret }) => ({
    default: defaultValue,
    name,
    prompt: prompt ?? undefined,
    required,
    secret
  }))

export function parseConnectionTarget(entry: ConnectionOperationTarget): ConnectionTarget | null {
  const name = entry.name.trim()

  if (!name) {
    return null
  }

  return {
    action: entry.action ?? 'install',
    alias: entry.alias ?? null,
    connectUrl: entry.connect_url ?? null,
    connectionId: entry.connection_id ?? '',
    detail: entry.detail ?? '',
    discoveryError: entry.discovery_error ?? null,
    instructions: entry.instructions ?? null,
    // An unknown kind from a backend a version ahead renders as the generic MCP row.
    kind: entry.kind ?? 'mcp',
    name,
    requiredEnv: envFields(entry.required_env),
    state: entry.state ?? 'pending',
    tools: entry.tools ?? []
  }
}
