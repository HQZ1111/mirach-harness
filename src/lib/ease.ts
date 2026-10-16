/**
 * beUI 动效常量（2026-10-14 令牌统一版）——**数据源 = tokens.css 的
 * 「beUI 动效令牌」段**（唯一源头：改数值只改 tokens.css，全部组件跟随）。
 *
 * 读取方式：模块顶层读一次 CSS 变量。**前提 = main.tsx 的样式 import 先于
 * app 图求值**（2026-10-16 实锤：此前 app 图在前，本模块全部静默回退内置值，
 * 改 tokens.css 不生效；已把样式 import 提至 app import 之前，勿再挪回）。
 * **导出形状不变**（`SPRING_PRESS` 等仍是值不是函数）——34 个 beUI 组件
 * 的 `transition={SPRING_PRESS}` 用法零改动。
 *
 * 回退值与 tokens.css 的 --beui-spring-* 定义一致（注释注明，勿单边改）：
 * 回退只在无 DOM 环境（node 测试/SSR）启用——浏览器里令牌缺失是缺陷，
 * 必须可见（console.error），见 readNum/readEase。
 */

const readNum = (name: string): number | null => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    if (!raw) {
      // 有 DOM 却取不到 = 缺陷（样式注入序错/令牌被删）——可见后回退
      // 内置值保运行（错误就是错误：调用方在控制台能看到）。
      console.error(
        `[ease] 令牌 ${name} 未定义——回退内置值（tokens.css 是否先于本模块求值？）`,
      )
      return null
    }
    const n = Number.parseFloat(raw)
    if (!Number.isFinite(n)) {
      console.error(`[ease] 令牌 ${name} 不是数值——回退内置值`, raw)
      return null
    }
    return n
  } catch {
    return null
  }
}

/** 读 spring 三数值拼 motion 形状；回退三元组与 tokens.css 注释同步。 */
const springOf = (
  key: string,
  fb: { stiffness: number; damping: number; mass: number },
): { type: 'spring'; stiffness: number; damping: number; mass: number } => ({
  type: 'spring',
  stiffness: readNum(`--beui-spring-${key}-s`) ?? fb.stiffness,
  damping: readNum(`--beui-spring-${key}-d`) ?? fb.damping,
  mass: readNum(`--beui-spring-${key}-m`) ?? fb.mass,
})

/** 读 duration+bounce 式 spring（visualDuration 语义：视觉到达目标的时间）。 */
const visualSpringOf = (
  key: string,
  fb: { dur: number; bounce: number },
): { type: 'spring'; visualDuration: number; bounce: number } => ({
  type: 'spring',
  visualDuration: readNum(`--beui-spring-${key}-dur`) ?? fb.dur,
  bounce: readNum(`--beui-spring-${key}-bounce`) ?? fb.bounce,
})

/** 读 duration+bounce 式 spring（duration 语义：物理弹簧时长）。 */
const durSpringOf = (
  key: string,
  fb: { dur: number; bounce: number },
): { type: 'spring'; duration: number; bounce: number } => ({
  type: 'spring',
  duration: readNum(`--beui-spring-${key}-dur`) ?? fb.dur,
  bounce: readNum(`--beui-spring-${key}-bounce`) ?? fb.bounce,
})

const readEase = (name: string, fb: readonly [number, number, number, number]) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fb
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    const m = raw.match(/cubic-bezier\(([^)]+)\)/)
    if (!m) {
      // 同 readNum：有 DOM 却取不到/格式不对 = 缺陷，可见后回退
      console.error(`[ease] 令牌 ${name} 缺失或不是 cubic-bezier——回退内置值`, raw)
      return fb
    }
    const parts = m[1]!.split(',').map((x) => Number.parseFloat(x.trim()))
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      console.error(`[ease] 令牌 ${name} 不是 cubic-bezier——回退内置值`, raw)
      return fb
    }
    return parts as unknown as readonly [number, number, number, number]
  } catch {
    return fb
  }
}

export const EASE_OUT = readEase('--beui-ease-out', [0.16, 1, 0.3, 1] as const)
export const EASE_IN_OUT = readEase('--beui-ease-in-out', [0.77, 0, 0.175, 1] as const)
export const EASE_DRAWER = readEase('--beui-ease-drawer', [0.32, 0.72, 0, 1] as const)

/** CSS string form of EASE_OUT for inline style transitions.（令牌同源值） */
export const EASE_OUT_CSS = 'cubic-bezier(0.16, 1, 0.3, 1)'

/** Press feedback on buttons and other tappable surfaces. */
export const SPRING_PRESS = springOf('press', { stiffness: 500, damping: 30, mass: 0.6 })

/** Content swaps — label/icon slots trading places inside a control. */
export const SPRING_SWAP = springOf('swap', { stiffness: 460, damping: 30, mass: 0.55 })

/** Overlay panel entrances — modals and sheets summoned by pointer. */
export const SPRING_PANEL = springOf('panel', { stiffness: 420, damping: 40, mass: 0.5 })

/** Shared-layout glides — pills, indicators and panels morphing between positions. */
export const SPRING_LAYOUT = springOf('layout', { stiffness: 360, damping: 32, mass: 0.6 })

/** Cursor-follow physics for decorative mouse tracking (magnetic, tilt, dock). */
export const SPRING_MOUSE = springOf('mouse', { stiffness: 200, damping: 15, mass: 0.3 })

/** Dragged handles and fills (sliders) — critically damped `useSpring` config,
 * so the value follows the pointer butterily and never rebounds off an end. */
export const SPRING_GLIDE = springOf('glide', { stiffness: 700, damping: 50, mass: 0.5 })

// ── 组件特异 spring（2026-10-16 令牌统一版：原散落在各 vendored 组件的
//    本地常量全部收拢到 tokens.css「spring 组」，此处读取、组件改 import——
//    数值唯一源头。原组件本地常量删除，头注释注明令牌来源） ──

/** Tabs 指示器（刻意无过冲：可滚动列表里过冲=瞬时滚动条+布局抖动） */
export const SPRING_TABS = springOf('tabs', { stiffness: 245, damping: 36, mass: 1.2 })

/** Toast 堆叠（layout/进出） */
export const SPRING_TOAST_STACK = springOf('toast', { stiffness: 420, damping: 34, mass: 0.75 })

/** Popover goo（过量 bounce 会让液滴脖子胀出面板边缘） */
export const POPOVER_GOO_OPEN = visualSpringOf('goo-open', { dur: 0.3, bounce: 0.15 })
export const POPOVER_GOO_CLOSE = visualSpringOf('goo-close', { dur: 0.21, bounce: 0.15 })

/** Select 展开（visualDuration 式） */
export const SELECT_OPEN = visualSpringOf('unfold', { dur: 0.2, bounce: 0.12 })

/** Bouncy Accordion（duration 式：行位移不许 y 过冲——会漂出落点） */
export const ACCORDION_ROW = durSpringOf('accordion-row', { dur: 0.55, bounce: 0.38 })
export const ACCORDION_OPEN = durSpringOf('accordion-open', { dur: 0.58, bounce: 0.32 })
export const ACCORDION_CLOSE = durSpringOf('accordion-close', { dur: 0.46, bounce: 0.26 })
export const ACCORDION_CHEVRON = durSpringOf('accordion-chevron', { dur: 0.42, bounce: 0.28 })

/** Color Picker 放大镜升起 */
export const MAGNIFIER_RISE = springOf('loupe', { stiffness: 520, damping: 24, mass: 0.6 })

/** Popover-Morph 进场（非回弹 spring 260ms 内静止，比 SPRING_PANEL 慢尾更合） */
export const MORPH_ENTER = durSpringOf('morph', { dur: 0.26, bounce: 0 })
