/**
 * 审查面板的 dockview 入口（`review` 面板类型的组件）。
 *
 * 2026-10-27：用户要求"完整复刻 hermes 桌面端的技能与中心与审查页面"——
 * 旧的简化版（单文件 650 行，自写 churn/树/diff）已整体替换为
 * `components/panes/review/`（hermes `app/right-sidebar/review/` 逐文件移植：
 * index / file-tree / scope-row / ship-bar / churn-bar / tree-data）。
 *
 * 本文件只做两件事：
 * 1. 面板挂载时把仓库根对齐到活动会话的 cwd（上游 `$currentCwd` 订阅的
 *    宿主对偶；dockview 面板是常驻的，所以还要在 cwd 变化时跟随）；
 * 2. 渲染移植后的 `ReviewPane`，关闭按钮走 dockview 面板关闭。
 */
import { useEffect } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'

import { ReviewPane } from '@/components/panes/review'
import { activeSessionCwd, reviewStore } from '@/components/panes/review-store'

export function ReviewPanelHost(props: IDockviewPanelProps) {
  // 挂载即对齐仓库根（无会话 cwd 时保持空 → 面板显示"不是仓库"的真空态，
  // 而不是拿某个硬编码目录冒充）。
  useEffect(() => {
    const cwd = activeSessionCwd()
    if (cwd) reviewStore.getState().setRepoCwd(cwd)
  }, [])

  // 活动会话切换 → 仓库根跟随（上游 `$currentCwd.subscribe` 同语义：
  // 未定向到其它工作区时跟随活动会话）。
  useEffect(() => {
    let last = activeSessionCwd()
    return reviewStore.subscribe(() => {
      const cwd = activeSessionCwd()
      if (cwd && cwd !== last) {
        last = cwd
        reviewStore.getState().setRepoCwd(cwd)
      }
    })
  }, [])

  return <ReviewPane onClose={() => props.api.close()} />
}
