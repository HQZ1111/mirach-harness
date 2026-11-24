/**
 * 数据同步结果整形（纯函数，设置页与测试共用）。
 *
 * 口径照 ZCode `docs/remote/data-sync.md`：推送只新增远端缺失条目，
 * 同名不同内容只报差异、不覆盖；失败条目必须逐条可见（不吞）。
 */
export interface SyncPushResult {
  connectionId: string
  added: string[]
  unchanged: string[]
  different: string[]
  failed: { name: string; error: string }[]
  totalLocal: number
}

export function summarizePushResult(result: SyncPushResult): string {
  const parts: string[] = []
  if (result.added.length > 0) parts.push(`已推送 ${result.added.length} 个`)
  if (result.unchanged.length > 0) parts.push(`已是最新 ${result.unchanged.length} 个`)
  if (result.different.length > 0) parts.push(`有差异未覆盖 ${result.different.length} 个`)
  if (result.failed.length > 0) parts.push(`失败 ${result.failed.length} 个`)
  if (parts.length === 0) {
    return result.totalLocal === 0 ? '本机没有可推送的 MCP 服务器' : '没有需要同步的条目'
  }
  return parts.join('；')
}

export function formatSyncTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return new Date(ms).toLocaleString()
}
