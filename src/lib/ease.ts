/**
 * beUI 动效常量（2026-10-14 令牌统一版）——**数据源 = tokens.css 的
 * 「beUI 动效令牌」段**（唯一源头：改数值只改 tokens.css，全部组件跟随）。
 *
 * 读取方式：模块顶层读一次 CSS 变量（vite 下样式注入先于组件模块求值，
 * 此处可读；每值惰性回退——变量缺失时用 beUI 原始数值，见下）。
 * **导出形状不变**（`SPRING_PRESS` 等仍是值不是函数）——34 个 beUI 组件
 * 的 `transition={SPRING_PRESS}` 用法零改动。
 *
 * 回退值与 tokens.css 的 --beui-spring-* 定义一致（注释注明，勿单边改）：
 * 回退只在 CSS 缺失时启用（node 测试/SSR），浏览器里永远走令牌值。
 */

const readNum = (name: string): number | null => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    if (!raw) return null
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

const readEase = (name: string, fb: readonly [number, number, number, number]) => {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fb
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    const m = raw.match(/cubic-bezier\(([^)]+)\)/)
    if (!m) return fb
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

// ── 组件特异 spring（beUI 组件本地值；尚未进令牌组——如后续多处复用
//    再提取到 tokens.css 的 spring 组） ──

/** Tabs 指示器（刻意无过冲：可滚动列表里过冲=瞬时滚动条+布局抖动） */
export const SPRING_TABS = springOf('tabs', { stiffness: 245, damping: 36, mass: 1.2 })

/** Toast 堆叠（layout/进出） */
export const SPRING_TOAST_STACK = springOf('toast', { stiffness: 420, damping: 34, mass: 0.75 })

/** Popover goo（过量 bounce 会让液滴脖子胀出面板边缘） */
export const POPOVER_GOO_OPEN = { type: 'spring', visualDuration: 0.3, bounce: 0.15 } as const
export const POPOVER_GOO_CLOSE = { type: 'spring', visualDuration: 0.21, bounce: 0.15 } as const

/** Select 展开 */
export const SELECT_OPEN = { type: 'spring', visualDuration: 0.2, bounce: 0.12 } as const

/** Bouncy Accordion（duration 式：行位移不许 y 过冲——会漂出落点） */
export const ACCORDION_ROW = { duration: 0.55, bounce: 0.38 } as const
export const ACCORDION_OPEN = { duration: 0.58, bounce: 0.32 } as const
export const ACCORDION_CLOSE = { duration: 0.46, bounce: 0.26 } as const
export const ACCORDION_CHEVRON = { duration: 0.42, bounce: 0.28 } as const

/** Color Picker 放大镜升起 */
export const MAGNIFIER_RISE = { type: 'spring', stiffness: 520, damping: 24, mass: 0.6 } as const

/** Popover-Morph 进场（非回弹 spring 260ms 内静止，比 SPRING_PANEL 慢尾更合） */
export const MORPH_ENTER = { type: 'spring', duration: 0.26, bounce: 0 } as const
