/**
 * 谱系条父会话名反查（任务 3：SessionLineBar 的「分叉自『…』」从原始
 * jsonl 文件名改为父会话名）。数据源：pi_list_sessions 的 SessionMeta 带
 * path + name（branch-store 的 lineage.branchedFrom 是父会话文件路径，
 * parseSessionLineage——branch-store.ts 头注「string = 父会话文件路径」）。
 *
 * hermes 参照（fork 行的名称语义）：flattenSessionsWithBranches 把分支子
 * 会话嵌在父会话名下渲染（session-branch-tree.ts:97-106 emit 的 branchStem
 * 「└─ 」挂在父 session 名下——名称的真相是父会话的可显示名，不是文件
 * 名）；pi 的 lineage 只暴露路径（pi_get_session_lineage 裸
 * Option<String>），所以反查 = path 匹配 pi_list_sessions 的 name。
 *
 * 模块级缓存：lazy 查一次 pi_list_sessions（多次会话切换/fork 不重复发
 * IPC——父会话名在一次加载内稳定）；失败不缓存失败态（下次查询重试，
 * console.error 可见——禁止兜底）；查无此 path / name 为空 → 组件层回退
 * 文件名尾段（任务定稿，resolveLineageParentName 返回 null）。
 */
import { invoke } from '@tauri-apps/api/core'

import { normalizeDisplayPath } from './session-display'

/** pi_list_sessions 行的反查面（只需 path + name）。 */
export interface LineageParentCandidate {
  readonly name: string | null
  readonly path: string
}

/**
 * 纯函数（供单测）：按 path 匹配父会话的可显示名。分隔符规整
 * （normalizeDisplayPath——\\ 与 / 同义）后精确相等；无匹配条目 / name
 * 为空（pi name 是可空列，未命名会话）→ null（组件层回退文件名尾段）。
 */
export function resolveLineageParentName(
  branchedFrom: string,
  sessions: readonly LineageParentCandidate[],
): string | null {
  const target = normalizeDisplayPath(branchedFrom)
  for (const candidate of sessions) {
    if (normalizeDisplayPath(candidate.path) === target && candidate.name) {
      return candidate.name
    }
  }
  return null
}

let sessionsPromise: Promise<readonly LineageParentCandidate[]> | null = null

const fetchSessionsOnce = (): Promise<readonly LineageParentCandidate[]> => {
  if (!sessionsPromise) {
    sessionsPromise = invoke<LineageParentCandidate[]>('pi_list_sessions')
      .then((metas) => metas ?? [])
      .catch((e) => {
        console.error('[lineage] pi_list_sessions 读取失败——父会话名回退文件名尾段', e)
        // 失败态不缓存（下一次查询重试）；本轮返回空表 = 反查 null =
        // 组件层文件名尾段兜底（任务定稿）。错误已 console 可见。
        sessionsPromise = null
        return []
      })
  }
  return sessionsPromise
}

/**
 * 组件层的 lazy 查询（SessionLineBar 挂载时调用）：模块级缓存一次
 * pi_list_sessions，按 path 反查父会话名；反查不到返回 null。
 */
export async function lookupLineageParentName(branchedFrom: string): Promise<string | null> {
  const sessions = await fetchSessionsOnce()
  return resolveLineageParentName(branchedFrom, sessions)
}
