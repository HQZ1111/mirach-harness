/**
 * 会话页签 bridge（docs/layout-design.md v6.0 §5/§8）——布局层（flex-layout）
 * 与 runtime（switchToThread 单投影）解耦的双向登记口：
 *  - flex-layout 注册 `openSessionTab` 实现（页签落模型），thread-list 的
 *    会话行跨面拖拽经 openSessionTabBridge 调它（解耦不引环，preview-opener
 *    同款模式）；
 *  - runtime 注册 `switchToThread` 实现，页签激活（SELECT_TAB）经
 *    switchSessionThreadBridge 切会话。
 * 未注册时调用 = 错误可见（console.error，规矩 12：不静默装成功）。
 */

export type OpenSessionTabFn = (threadId: string, targetTabsetId?: string) => void
export type SwitchSessionThreadFn = (threadId: string) => void

let openTab: OpenSessionTabFn | null = null
let switcher: SwitchSessionThreadFn | null = null

export function setSessionTabOpener(fn: OpenSessionTabFn | null) {
  openTab = fn
}

export function setSessionThreadSwitcher(fn: SwitchSessionThreadFn | null) {
  switcher = fn
}

export function openSessionTabBridge(threadId: string, targetTabsetId?: string) {
  if (!openTab) {
    console.error('[session-tab-bridge] openSessionTab 未注册（flex-layout 未挂载）')
    return
  }
  openTab(threadId, targetTabsetId)
}

export function switchSessionThreadBridge(threadId: string) {
  if (!switcher) {
    console.error('[session-tab-bridge] switchToThread 未注册（runtime 未挂载）')
    return
  }
  switcher(threadId)
}
