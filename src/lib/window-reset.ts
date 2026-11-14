/**
 * 窗口复位（用户 2026-10-16：右键菜单「默认布局」的窗口半边——"软件宽度
 * 高度，布局恢复默认形态"）。
 *
 * 尺寸**不再写死**（2026-10-22）：按 hermes 公式取该屏工作区的 88%，夹在
 * 1280×820 ~ 1760×1100（单源 `@/lib/window-metrics`，与 Rust 侧
 * `main.rs::hermes_window_size` 同一公式）。早先固定 1800×1000，在小屏上
 * 会把窗口顶出屏幕，也违背"首屏尺寸跟屏幕走"的既有语义。
 *
 * **必须等尺寸真落地再返回**（2026-10-22 实锤）：布局复位按 dockview 的
 * **当前**容器宽算主栏占多少。若窗口尺寸还没生效就复位布局，栏会按旧窗口
 * 摊（例如 900 宽窗口下三栏挤到 min），随后窗口放大时 dockview 按存档比例
 * 摊开——列宽全乱。所以这里轮询 `innerSize()` 直到命中目标再 resolve。
 *
 * 存档也会被这次改动覆盖：Rust 侧在 Resized/Moved 后 400ms 防抖写
 * `window-state.json`，复位产生的 resize 自然落盘（下次启动读到的就是复位
 * 后的几何，不会"复位了但下次开还是旧的"）。
 *
 * 最大化态先 unmaximize：最大化窗 setSize 是无效操作（窗口管理器接管尺寸），
 * 且圆角偏好按 is_maximized 切 DONOTROUND——不还原直接 setSize 会留
 * 直角全屏态。unmaximize 未授权时 capabilities 拦 → console.error 可见
 * （规矩 12；capabilities/default.json 已加 allow-unmaximize/allow-center）。
 *
 * 浏览器直开（inTauri=false）no-op（无窗可复位）。
 */
import { LogicalSize } from '@tauri-apps/api/dpi'

import { appWindow, inTauri } from '@/lib/tauri-window'
import { hermesWindowSize } from '@/lib/window-metrics'

/** 等窗口尺寸真落地（WebView2 的 resize 是异步的，setSize 返回不代表已生效）。 */
const waitForInnerSize = async (
  win: NonNullable<typeof appWindow>,
  target: { width: number; height: number },
  timeoutMs = 1500,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const cur = await win.innerSize()
    if (Math.abs(cur.width - target.width) <= 2 && Math.abs(cur.height - target.height) <= 2) return true
    if (Date.now() > deadline) {
      console.error('[window-reset] 窗口尺寸未在超时内落地', { target, current: cur })
      return false
    }
    await new Promise((r) => setTimeout(r, 40))
  }
}

export async function resetWindowToFactory(): Promise<void> {
  const win = appWindow
  if (!inTauri || !win) return
  try {
    if (await win.isMaximized()) {
      await win.unmaximize()
    }
    // 工作区 = 屏幕可用区（已排除任务栏）。`screen.availWidth` 是 CSS 像素
    // ——与 LogicalSize 同单位，不需要按 dpr 换算。
    const target = hermesWindowSize(window.screen.availWidth, window.screen.availHeight)
    // 同值 setSize 是 no-op（AGENTS 已知陷阱：API 报目标尺寸而 viewport 可能
    // 卡在更小尺寸）——当前尺寸已等于目标时先设一个不同值强制触发 resize，
    // 再设目标值（两步恢复法）。
    const current = await win.innerSize()
    if (current.width === target.width && current.height === target.height) {
      await win.setSize(new LogicalSize(target.width - 60, target.height - 60))
    }
    await win.setSize(new LogicalSize(target.width, target.height))
    await win.center()
    await waitForInnerSize(win, target)
    console.info('[window-reset] 窗口已复位为出厂尺寸并居中', target)
  } catch (e) {
    console.error('[window-reset] 窗口复位失败', e)
  }
}
