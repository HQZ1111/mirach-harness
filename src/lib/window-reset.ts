/**
 * 窗口复位（用户 2026-10-16：右键菜单「默认布局」的窗口半边——"软件宽度
 * 高度，布局恢复默认形态"）。尺寸 = tauri.conf.json 主窗出厂值
 * （1800×1000，LogicalSize——与 config 的 width/height 同语义）+ center()。
 *
 * 最大化态先 unmaximize：最大化窗 setSize 是无效操作（窗口管理器接管尺寸），
 * 且 SetWindowRgn 圆角区域按 is_maximized 清空——不还原直接 setSize 会留
 * 无圆角全屏态。unmaximize 未授权时 capabilities 拦 → console.error 可见
 * （规矩 12；capabilities/default.json 已加 allow-unmaximize/allow-center）。
 *
 * 浏览器直开（inTauri=false）no-op（无窗可复位）。
 */
import { LogicalSize } from '@tauri-apps/api/dpi'

import { appWindow, inTauri } from '@/lib/tauri-window'

/** 出厂主窗尺寸（tauri.conf.json windows[0] 的 width/height 同值）。 */
export const FACTORY_WINDOW_SIZE = { width: 1800, height: 1000 } as const

export async function resetWindowToFactory(): Promise<void> {
  const win = appWindow
  if (!inTauri || !win) return
  try {
    if (await win.isMaximized()) {
      await win.unmaximize()
    }
    // CEF 同值 setSize 是 no-op（AGENTS 已知陷阱：API 报 1800×1000 而
    // viewport 可能卡在更小尺寸）——当前尺寸已等于目标时先设一个不同值
    // 强制触发 resize，再设目标值（两步恢复法）。
    const current = await win.innerSize()
    if (current.width === FACTORY_WINDOW_SIZE.width && current.height === FACTORY_WINDOW_SIZE.height) {
      await win.setSize(new LogicalSize(FACTORY_WINDOW_SIZE.width - 60, FACTORY_WINDOW_SIZE.height - 60))
    }
    await win.setSize(new LogicalSize(FACTORY_WINDOW_SIZE.width, FACTORY_WINDOW_SIZE.height))
    await win.center()
    console.info('[window-reset] 窗口已复位为出厂尺寸并居中')
  } catch (e) {
    console.error('[window-reset] 窗口复位失败', e)
  }
}
