/**
 * IME 安全的 Enter 判定（hermes lib/ime.ts 逐字照抄）。
 *
 * 中文/日文用户在合成期按 Enter 是"上屏候选词"，不能同时充当字段动作
 * （提交/改名）快捷键。浏览器两路信号：原生键盘事件的 isComposing（标准），
 * 以及 legacy keyCode===229（Chromium/Safari 在合成边界仍会盖——包括
 * compositionend 之后到达、isComposing 已 false 的那一下上屏 Enter）。
 * 一个谓词独占这份策略，调用点不得各自漂移。
 */

export interface ImeAwareKeyEvent {
  key: string
  isComposing?: boolean
  keyCode?: number
  nativeEvent?: {
    isComposing?: boolean
    keyCode?: number
  }
}

/** 该键盘事件是否处于活动合成期。 */
export function isImeComposing(event: ImeAwareKeyEvent): boolean {
  const native = event.nativeEvent ?? event

  return Boolean(native.isComposing || event.isComposing) || native.keyCode === 229 || event.keyCode === 229
}

/** 真提交 Enter（不是合成上屏）。 */
export function isSubmitEnter(event: ImeAwareKeyEvent): boolean {
  return event.key === 'Enter' && !isImeComposing(event)
}
