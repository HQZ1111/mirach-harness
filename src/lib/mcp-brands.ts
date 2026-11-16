/** MCP 品牌图标映射（hermes `lib/mcp-brands.ts` 的最小对偶）。 */
export interface McpBrand {
  id: string
  name: string
  color?: string
}

export const MCP_BRANDS: readonly McpBrand[] = [
  { id: 'filesystem', name: 'Filesystem' },
  { id: 'github', name: 'GitHub' },
  { id: 'slack', name: 'Slack' },
  { id: 'postgres', name: 'Postgres' },
]

export function mcpBrandFor(id: string): McpBrand | null {
  return MCP_BRANDS.find((b) => b.id === id) ?? null
}

/** 上游 `brandFor`：mcpBrandFor 的别名。 */
export const brandFor = mcpBrandFor
