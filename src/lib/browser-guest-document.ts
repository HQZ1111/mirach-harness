/**
 * 浏览器访客文档（hermes `lib/browser-guest-document.ts`）。
 *
 * 上游用于内嵌浏览器面板的 guest webview 文档注入。**宿主没有内嵌浏览器**
 * （bots 的 screen-pane 用 noVNC 且当前不可用），所以这里返回 null 让调用方
 * 走"无文档"分支，而不是伪造一个 document。
 */
export function guestDocument(): null {
  return null
}
