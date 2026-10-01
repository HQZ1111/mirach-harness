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

export type SessionActionId =
  | 'rename'
  | 'pin'
  | 'unread'
  | 'copy-id'
  | 'branch'
  | 'export'
  | 'archive'
  | 'delete'

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
  /** 该行当前未读（决定 标记为已读/标记为未读 文案——hermes 同一 read-state
   *  项，双源驱动：水位差距或显式标记任一命中即「未读」）。 */
  readonly unread: boolean
  /** 该行当前已归档（决定 归档/取消归档 文案——hermes row.archive，取消
   *  归档走 zh archivedChats 段 unarchive 原文）。 */
  readonly archived: boolean
}

/**
 * 投影结果（适用子集的 hermes 原序）：
 *   重命名…（edit）· 置顶/取消置顶（pin）· 标记为已读/未读（mail）
 *   · 复制 ID（copy）
 *   ―― 分隔 ――
 *   分支（repo-forked）· 导出（cloud-download）
 *   ―― 分隔 ――
 *   归档/取消归档（archive）· 删除（trash，destructive）
 *
 * 不适用（数据面无）：在新标签页中打开 / 新窗口 / 在终端中打开（主会话区
 * 单线程投影，见重审计 #7）、外观色板与移到项目（pi 无会话色/无项目实体
 * ——按工作区分组以 cwd 为键，见重审计 #2）。删除仍走 destructive 末位 +
 * 确认弹层（hermes #61470 语义）。
 */
export function projectSessionActions({
  pinned,
  branchDisabled,
  unread,
  archived,
}: SessionActionFlags): SessionActionSpec[] {
  return [
    { kind: 'item', id: 'rename', label: '重命名…', disabled: false },
    { kind: 'item', id: 'pin', label: pinned ? '取消置顶' : '置顶', disabled: false },
    // hermes：一个 read-state 项由未读两面驱动（session-actions-menu.tsx
    // identityItems 第三项）；已读 = 打开信封图标语义。
    { kind: 'item', id: 'unread', label: unread ? '标记为已读' : '标记为未读', disabled: false },
    // hermes：复制 ID 归 IDENTITY 组（CopyButton），排在外观之后。
    { kind: 'item', id: 'copy-id', label: '复制 ID', disabled: false },
    { kind: 'separator', id: 'work' },
    { kind: 'item', id: 'branch', label: '分支', disabled: branchDisabled },
    // hermes：WORK 组第二项（cloud-download）；pi 实现走 pi_export_session_html
    // （Session::to_html / export_snapshot——见 pi_session.rs）。
    { kind: 'item', id: 'export', label: '导出', disabled: false },
    { kind: 'separator', id: 'danger' },
    // hermes：DANGER 组首位（archive），删除在其后（destructive-red）。
    { kind: 'item', id: 'archive', label: archived ? '取消归档' : '归档', disabled: false },
    { kind: 'item', id: 'delete', label: '删除', disabled: false, destructive: true },
  ]
}
