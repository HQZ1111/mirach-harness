/**
 * 会话页签 bridge（docs/layout-design.md §5/§8）——布局层（dockview-shell）
 * 与 runtime（switchToThread 主会话切换）解耦的双向登记口：
 *  - dockview-shell 注册 `openSessionTab` 实现（面板落位），thread-list 的
 *    会话行跨面拖拽经 openSessionTabBridge 调它（解耦不引环，preview-opener
 *    同款模式）。**2026-10-15 起带落点**：position = { referenceGroup,
 *    direction }——拖到哪个组、哪个方位就开在哪儿（旧版恒 right of
 *    workspace，拖到左半边也开右侧 = 「拖拽没效果」的根因）；position 缺省
 *    （非拖拽调用）保持旧语义 right of workspace；
 *  - runtime 注册 `switchToThread` 实现（侧栏行点击 = 切主会话；会话页签
 *    自持静态投影，激活页签不再切运行时线程）；
 *  - dockview-shell 另注册**新栏**开门（`setSessionColumnOpener`）——插件
 *    `host.openSession(id, {intent:'tab'})`（hermes「在新标签页中打开机器人
 *    聊天」/「Open recent session」）落成主区**右侧分出的独立会话栏**，
 *    不再抢主 workspace（2026-11-20 用户定稿："改成打开一个新栏"）。
 * 未注册时调用 = 错误可见（console.error，规矩 12：不静默装成功）。
 */

/** 落点方位（dockview Direction 的结构同型——该类型未从 dockview-core 顶层
 *  导出，字面量联合自持；addPanel 的 position.direction 直接消费）。 */
export type SessionTabDirection = 'left' | 'right' | 'above' | 'below' | 'within'

export interface SessionTabDropPosition {
  /** dockview 组 id（group.id——拖拽目标组的稳定身份）。 */
  referenceGroup: string
  direction: SessionTabDirection
}

export type OpenSessionTabFn = (threadId: string, position?: SessionTabDropPosition) => void
export type SwitchSessionThreadFn = (threadId: string) => void
/** 按存储会话 id 打开（不要求该行已在侧栏目录里——新建 bot 会话即此情形）。 */
export type OpenStoredSessionFn = (storedSessionId: string) => void

/** 在**新栏**打开一个会话（插件 `host.openSession(id, {intent:'tab'})` 的
 *  「在新标签页中打开机器人聊天」对偶）。与 OpenSessionTabFn 的区别：
 *  只按存储 id 定位，且**恒向右分一栏**（不要求会话已在侧栏目录）。 */
export type OpenSessionColumnFn = (
  storedSessionId: string,
  options?: { title?: string },
) => void
/** 该存储会话是否已作为会话栏在屏；已开则置前并返回 true。 */
export type FocusSessionColumnFn = (storedSessionId: string) => boolean

let openTab: OpenSessionTabFn | null = null
let switcher: SwitchSessionThreadFn | null = null
let storedOpener: OpenStoredSessionFn | null = null
let columnOpener: OpenSessionColumnFn | null = null
let columnFocuser: FocusSessionColumnFn | null = null

export function setSessionTabOpener(fn: OpenSessionTabFn | null) {
  openTab = fn
}

export function setSessionThreadSwitcher(fn: SwitchSessionThreadFn | null) {
  switcher = fn
}

export function setSessionColumnOpener(
  fn: OpenSessionColumnFn | null,
  focus: FocusSessionColumnFn | null = null,
) {
  columnOpener = fn
  columnFocuser = focus
}

export function openSessionTabBridge(threadId: string, position?: SessionTabDropPosition) {
  if (!openTab) {
    console.error('[session-tab-bridge] openSessionTab 未注册（dockview-shell 未挂载）')
    return
  }
  openTab(threadId, position)
}

export function switchSessionThreadBridge(threadId: string) {
  if (!switcher) {
    console.error('[session-tab-bridge] switchToThread 未注册（runtime 未挂载）')
    return
  }
  switcher(threadId)
}

export function setStoredSessionOpener(fn: OpenStoredSessionFn | null) {
  storedOpener = fn
}

/** 打开一个存储会话（插件 `host.openSession`）。id 来自 pi 索引，可能还没
 *  进侧栏目录（刚创建的 bot 会话）——runtime 侧按 pi_list_sessions 补路径。 */
export function openStoredSessionBridge(storedSessionId: string) {
  if (!storedOpener) {
    console.error('[session-tab-bridge] openStoredSession 未注册（runtime 未挂载）')
    return
  }
  storedOpener(storedSessionId)
}

/** 在新栏打开一个存储会话（intent='tab'；dockview 未挂载 = 错误可见）。 */
export function openSessionColumnBridge(
  storedSessionId: string,
  options?: { title?: string },
) {
  if (!columnOpener) {
    console.error('[session-tab-bridge] openSessionColumn 未注册（dockview-shell 未挂载）')
    return
  }
  columnOpener(storedSessionId, options)
}

/** 该存储会话已作为会话栏在屏？已开则置前并返回 true（未注册 = false，
 *  调用方按"不在屏"继续走主会话切换，这与"未注册 = 错误可见"不冲突：
 *  注册缺失由 openSessionColumnBridge 报错）。 */
export function focusSessionColumnBridge(storedSessionId: string): boolean {
  return columnFocuser ? columnFocuser(storedSessionId) : false
}
