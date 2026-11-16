/**
 * 输入模态（hermes `lib/input-modality.ts`）。
 *
 * 上游用它决定「焦点环是否显示」「hover 是否生效」。宿主用同一套判定：
 * 最近一次交互是键盘 → keyboard 模态；否则 pointer。
 */
export type InputModality = 'keyboard' | 'pointer' | 'touch'

let current: InputModality = 'pointer'

export function getInputModality(): InputModality {
  return current
}

export function setInputModality(next: InputModality): void {
  current = next
}

/**
 * 上游同名 API：最近一次 pointerdown/keydown 的设备。
 *
 * hermes-mirror 的 `qualifyFocusVisible` 用它过滤 `:focus-visible`（Radix 菜单
 * 打开/关闭后焦点恢复会被 Chromium 误判成键盘态）。`touch` 在宿主归入
 * pointer（上游只有 keyboard/pointer 两态）。
 */
export function lastInputModality(): 'keyboard' | 'pointer' {
  return current === 'keyboard' ? 'keyboard' : 'pointer'
}

/** 全局监听一次（幂等）。 */
let installed = false
export function installInputModalityTracking(): void {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', () => { current = 'keyboard' }, true)
  window.addEventListener('pointerdown', (e) => {
    current = (e as PointerEvent).pointerType === 'touch' ? 'touch' : 'pointer'
  }, true)
}
