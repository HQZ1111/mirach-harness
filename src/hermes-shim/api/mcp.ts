/**
 * `@/api/mcp` shim — MCP server reads/writes.
 *
 * Upstream REST calls against the hermes backend's MCP endpoints. Host: pi's MCP
 * config lives in .pi/mcp.json (project) / ~/.pi/agent/mcp.json (global), reached
 * through `pi_mcp_*` IPC. `hermes.ts` owns the mapping; this file keeps the
 * signatures the mirrored code imports directly.
 *
 * `mcpOAuthRpc` has no counterpart: pi's MCP config has no OAuth dashboard flow
 * (that is hermes' managed-connector feature), so the factory returns a requester
 * that fails loudly — the tab's "authenticate" action is real upstream and must
 * not silently no-op here.
 */

import { getMcpCatalog as getCatalog, saveMcpServers as saveServers, testMcpServer as testServer } from '@/hermes-shim/hermes'
import type { McpCatalogResponse, McpServerSummary } from '@/hermes-mirror/types/hermes'

export interface McpTestResult {
  error?: string
  ok: boolean
  prompts?: number
  resources?: number
  tools: { description: string; name: string; schema_chars?: number }[]
}

export interface McpOAuthFlow {
  authorization_url: null | string
  error: null | string
  flow_id: string
  server_name: string
  status: 'approved' | 'authorization_required' | 'error' | 'starting'
  tools?: { description: string; name: string }[]
}

export async function testMcpServer(
  name: string,
  profile?: import('@/hermes-shim/api/client').ProfileScope
): Promise<McpTestResult> {
  return testServer(name, profile) as Promise<McpTestResult>
}

export async function saveMcpServers(
  servers: Record<string, Record<string, unknown>>,
  profile?: import('@/hermes-shim/api/client').ProfileScope
): Promise<{ ok: boolean }> {
  return saveServers(servers, profile)
}

export async function getMcpCatalog(
  profile?: import('@/hermes-shim/api/client').ProfileScope
): Promise<McpCatalogResponse> {
  return getCatalog(profile)
}

export async function installMcpCatalogEntry(
  name: string,
  env: Record<string, string> = {},
  profile?: import('@/hermes-shim/api/client').ProfileScope
): Promise<{ action?: string; background?: boolean; name?: string; ok: boolean; pid?: number }> {
  const hermes = await import('@/hermes-shim/hermes')
  void env
  return hermes.installMcpCatalogEntry(name, env, profile)
}

export function mcpOAuthRpc(_scope?: import('@/hermes-shim/api/client').ProfileScope) {
  return async <T>(_action: 'callback' | 'cancel' | 'poll' | 'start', _params: Record<string, unknown>): Promise<T> => {
    throw new Error('MCP OAuth 流程在本宿主不存在：pi 的 MCP 配置没有托管连接器/OAuth 面板')
  }
}

/** Structured list for the connectors page's "plugin servers" column. pi's
 *  snapshot has no runtime status (that is a hermes gateway report), so the rows
 *  would carry config facts only — and the connectors page builds its local
 *  column from the config record instead. Empty here, not fabricated. */
export async function listMcpServers(): Promise<{ servers: McpServerSummary[] }> {
  return { servers: [] }
}

export async function setMcpServerEnabled(name: string, enabled: boolean): Promise<{ ok: boolean }> {
  const hermes = await import('@/hermes-shim/hermes')
  const current = await hermes.getHermesConfigRecord()
  const servers = (current.mcp_servers ?? {}) as Record<string, Record<string, unknown>>
  const entry = servers[name]

  if (!entry) {
    throw new Error(`找不到 MCP 服务器：${name}`)
  }

  const next = { ...entry }
  if (enabled) delete next.enabled
  else next.enabled = false
  servers[name] = next

  return saveServers(servers)
}
