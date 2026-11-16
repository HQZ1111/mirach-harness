/**
 * `@novnc/novnc` 的类型声明（宿主未安装该包）。
 *
 * ## 为什么用声明而不是装包
 *
 * bots 的 `screen-pane.tsx` 用 `await import('@novnc/novnc')` **动态**加载
 * noVNC，用于连接远程桌面。宿主当前没有远程桌面功能，这个 import 在运行时
 * 会失败并走进该文件自己的 catch 分支（显示"不可用"）。
 *
 * 装一个 2MB 的包只为让类型检查通过是浪费——而且会让人误以为功能可用。
 * 声明成 `any` 形态，让**运行时的失败路径**成为唯一事实。
 *
 * 若将来真要接远程桌面，直接 `npm i @novnc/novnc` 并删掉本文件。
 */
declare module '@novnc/novnc' {
  const RFB: new (
    target: HTMLElement,
    url: string | WebSocket,
    options?: Record<string, unknown>,
  ) => {
    disconnect: () => void
    sendCredentials: (credentials: { username?: string; password?: string }) => void
    sendKey: (keysym: number, code: string) => void
    addEventListener: (type: string, listener: (event: unknown) => void) => void
  }
  export default RFB
}
