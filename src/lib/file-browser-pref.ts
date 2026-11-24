/**
 * 外观 → 文件浏览器 toggle 的跨窗口桥（2026-11-23）。
 *
 * 真实状态 = 主窗 dockview 面板 `files` 是否在场（布局存档自然持久化）；
 * 设置窗没有 dockview，只能读写一个 localStorage 镜像，主窗 shell 订阅它
 * 并开/关面板。两侧任何一边变化都写回同一键，避免 toggle 与面板脱节。
 */
const KEY = 'mirach:appearance.file-browser.v1'

type Listener = (open: boolean) => void

export function readFileBrowserOpen(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true'
  } catch (e) {
    console.error('[appearance] 读取文件浏览器状态失败', e)
    return false
  }
}

/**
 * 只写镜像；**不通知本窗口监听者**。主窗 shell 的 `handlePanelAdded/Removed`
 * 也会回写这个键——如果 write 同步回调 apply，removePanel 会在 dockview 的
 * 移除回调里重入 removePanel（开关关不掉面板）。跨窗口靠 storage 事件。
 */
export function writeFileBrowserOpen(open: boolean): void {
  try {
    localStorage.setItem(KEY, String(open))
  } catch (e) {
    console.error('[appearance] 保存文件浏览器状态失败', e)
  }
}

export function subscribeFileBrowser(listener: Listener): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY) listener(event.newValue === 'true')
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
