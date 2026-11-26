/**
 * 审查面板的 dockview 入口（`review` 面板类型的组件）。
 *
 * 2026-10-27：用户要求"完整复刻 hermes 桌面端的技能与中心与审查页面"——
 * 旧的简化版（单文件 650 行，自写 churn/树/diff）已整体替换为
 * `components/panes/review/`（hermes `app/right-sidebar/review/` 逐文件移植：
 * index / file-tree / scope-row / ship-bar / churn-bar / tree-data）。
 *
 * 本文件只做两件事：
 * 1. 面板挂载时把仓库根对齐到**工作区根**（用户可见的文件树根——文件树
 *    与审查同源，2026-11-26 用户："审查页也是假的"：此前绑活动会话 cwd，
 *    本机会话多为 `C:/Users/<user>`，不是仓库 → 审查恒空）；
 * 2. 渲染移植后的 `ReviewPane`，关闭按钮走 dockview 面板关闭。
 */
import { useEffect } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'

import { ReviewPane } from '@/components/panes/review'
import { reviewStore } from '@/components/panes/review-store'
import { workspaceRootStore } from '@/lib/workspace-root'

export function ReviewPanelHost(props: IDockviewPanelProps) {
  // 挂载即对齐工作区根；用户以后在文件树里换目录，这里跟着换。
  useEffect(() => {
    const apply = (): void => {
      const root = workspaceRootStore.getState().root
      if (root) reviewStore.getState().setRepoCwd(root)
    }
    apply()
    return workspaceRootStore.subscribe(apply)
  }, [])

  return <ReviewPane onClose={() => props.api.close()} />
}
