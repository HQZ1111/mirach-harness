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
 *    自持静态投影，激活页签不再切运行时线程）。
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

let openTab: OpenSessionTabFn | null = null
let switcher: SwitchSessionThreadFn | null = null

export function setSessionTabOpener(fn: OpenSessionTabFn | null) {
  openTab = fn
}

export function setSessionThreadSwitcher(fn: SwitchSessionThreadFn | null) {
  switcher = fn
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
