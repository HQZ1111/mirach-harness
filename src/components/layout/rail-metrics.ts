/**
 * 栏宽口径（2026-10-22 用户定稿）。
 *
 * **默认值 = 300（定值，不随窗口缩放）**；许可区间 = [270, 400]。
 * 早先一版把默认宽做成"容器宽 × 1/6"，用户随后明确否掉：
 * "左侧栏和面板栏的默认尺寸是 300，最小 270，最大 400"。
 * 所以这里是三个纯常量，不存在比例换算——栏宽不跟着窗口大小跑。
 *
 * 与 hermes 的差异（参考值，不照抄）：hermes 左栏默认 237、min 237、max 360。
 *
 * 纯函数 + 无 DOM 依赖——单测直接覆盖边界与夹取顺序。
 */

/** 左/面板两轨的默认宽（用户定值） */
export const RAIL_DEFAULT_WIDTH = 300
/** 两轨许可区间（用户定值） */
export const RAIL_MIN_WIDTH = 270
export const RAIL_MAX_WIDTH = 400

/** 主栏（对话）最小宽：不参与栏宽口径——它是"再窄就没法读对话"的下限，
 *  与两侧栏无关（hermes 对应值是 `--chat-min-width: 28rem`）。 */
export const CHAT_MIN_WIDTH = 395

export interface RailBounds {
  min: number
  max: number
}

export const RAIL_BOUNDS: RailBounds = { min: RAIL_MIN_WIDTH, max: RAIL_MAX_WIDTH }

/**
 * 把任意宽度夹进许可区间。
 *
 * 非法输入（NaN / Infinity）不能静默变成默认值假装算过——那是 fail-open
 * （规矩 12）。显式报错后仍要给出一个可用值（调用方多为布局动词，抛错会
 * 让整条收放链断掉），但错误必须可见。
 */
export const clampRailWidth = (width: number, bounds: RailBounds = RAIL_BOUNDS): number => {
  if (!Number.isFinite(width)) {
    console.error('[rail-metrics] 栏宽非法——按默认宽处理', { width })
    return RAIL_DEFAULT_WIDTH
  }
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(width)))
}

/** 左栏默认宽 / 面板栏默认宽（两者同值；分开命名是为了调用点可读）。 */
export const leftRailDefaultWidth = (): number => RAIL_DEFAULT_WIDTH
export const panelsRailDefaultWidth = (): number => RAIL_DEFAULT_WIDTH

