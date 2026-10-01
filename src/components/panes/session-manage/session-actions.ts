/**
 * 会话行动作清单的纯投影（hermes chat/sidebar/session-actions-menu.tsx 的
 * useSessionActions spec 组照抄——⋯ 下拉与右键上下文菜单共用同一清单，
 * 永不漂移）。渲染在 thread-list.aui.tsx（MenuKit 模式，同 hermes
 * components/ui/actions-menu.tsx）。
 *
 * hermes 原清单顺序：OPEN（新标签页/新窗口/终端）｜IDENTITY（重命名/置顶/
 * 已读未读/外观/复制 ID）｜WORK（分支/导出/移到项目）｜TAB（标签页动词）｜
 * DANGER（归档/删除）。harness 数据面不适用的项（见各 spec 组注释）整体
 * 缺席；空组不出分隔线。
 *
 * 文案逐字取 hermes zh catalog（sidebar.row / common）。
 */

export type SessionActionId = 'rename' | 'pin' | 'copy-id' | 'branch' | 'delete'

export interface SessionActionItem {
  readonly kind: 'item'
  readonly id: SessionActionId
  readonly label: string
  readonly disabled: boolean
  readonly destructive?: boolean
}

export interface SessionActionSeparator {
  readonly kind: 'separator'
  readonly id: string
}

export type SessionActionSpec = SessionActionItem | SessionActionSeparator

export interface SessionActionFlags {
  /** 该行当前是否置顶（决定 置顶/取消置顶 文案） */
  readonly pinned: boolean
  /** 「分支」是否可用——pi fork 只作用于当前打开的会话文件，且需要 fork
   *  点清单（已落盘 user 消息）。非活动行/无 fork 点 → 禁用。 */
  readonly branchDisabled: boolean
}

/**
 * 投影结果（适用子集的 hermes 原序）：
 *   重命名…（edit）· 置顶/取消置顶（pin）· 复制 ID（copy）
 *   ―― 分隔 ――
 *   分支（repo-forked）
 *   ―― 分隔 ――
 *   删除（trash，destructive）
 *
 * 不适用（数据面无）：在新标签页中打开 / 新窗口 / 在终端中打开（主会话区
 * 单线程投影）、标记未读/已读 + 外观色板（pi 无已读态/无会话色）、导出 /
 * 移到项目 / 归档（pi 无导出命令/无项目/无归档）。删除仍走 destructive
 * 末位 + 确认弹层（hermes #61470 语义）。
 */
export function projectSessionActions({ pinned, branchDisabled }: SessionActionFlags): SessionActionSpec[] {
  return [
    { kind: 'item', id: 'rename', label: '重命名…', disabled: false },
    { kind: 'item', id: 'pin', label: pinned ? '取消置顶' : '置顶', disabled: false },
    // hermes：复制 ID 归 IDENTITY 组（CopyButton），排在外观之后。
    { kind: 'item', id: 'copy-id', label: '复制 ID', disabled: false },
    { kind: 'separator', id: 'work' },
    { kind: 'item', id: 'branch', label: '分支', disabled: branchDisabled },
    { kind: 'separator', id: 'danger' },
    { kind: 'item', id: 'delete', label: '删除', disabled: false, destructive: true },
  ]
}
