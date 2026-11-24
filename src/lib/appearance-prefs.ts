/**
 * 外观偏好（设置 →「外观」，2026-11-23）。
 *
 * 数值与默认值逐项照 hermes `app/settings/appearance-settings.tsx` 及其
 * store：界面缩放/聊天文字大小预设 90/100/110/125/150/175；聊天字号默认
 * **100**（2026-11-24 用户定稿——100% = 宿主旧的 15px，不是上游 110%）、
 * 终端字体、开场标识、聊天背景、消息气泡透明度。存储用宿主 localStorage
 * （跨窗口同源），每次变更立即写根 CSS 变量；主题（明暗/皮肤）走 hermes
 * 镜像的主题 Provider，不在这里重复一份。
 */
import { createStore } from 'zustand/vanilla'

import { $chatFontFamily } from '@/hermes-mirror/themes/chat-font'
import { logoFilterFor } from '@/lib/logo-tint'

export const UI_SCALE_PRESETS = [90, 100, 110, 125, 150, 175] as const
export const CHAT_TEXT_SCALE_PRESETS = [90, 100, 110, 125, 150, 175] as const
export type UiScalePreset = (typeof UI_SCALE_PRESETS)[number]
export type ChatTextScalePreset = (typeof CHAT_TEXT_SCALE_PRESETS)[number]

export const CHAT_FONT_SUGGESTIONS = [
  'OpenDyslexic',
  'Atkinson Hyperlegible',
  'Lexend',
  'Inter',
  'IBM Plex Sans',
  'Source Sans 3',
  'Noto Sans',
  'Segoe UI',
  'SF Pro Text',
] as const

export const ACCENT_SWATCHES = ['#006fff', '#f97316', '#ef4444', '#10b981', '#94a3b8', '#a855f7'] as const
export type AccentColor = (typeof ACCENT_SWATCHES)[number] | (string & {})

/** 文字颜色预设：与主题色同一组；空字符串 = 跟随主题。 */
export const TEXT_COLOR_SWATCHES = ACCENT_SWATCHES

export interface BuiltinBackdrop {
  path: string
  label: string
}

/**
 * 内置聊天背景（2026-11-24 用户："有内置的图片，就两个选项一个可以选择
 * 内置的图片切换，一个自定义上传图片"）。图片都是 public 下的静态资源，
 * 切换只写路径，不复制文件。
 */
export const BUILTIN_BACKDROPS: readonly BuiltinBackdrop[] = [
  { path: '/ds-assets/filler-bg0.jpg', label: '雕塑' },
  { path: '/brand/backgrounds/背景.png', label: '人物插画' },
  { path: '/brand/backgrounds/新中式壁画ID_1218283937.png', label: '新中式壁画' },
  { path: '/brand/backgrounds/新中式中式壁画_山水壁画_艺术壁画ID_1182978210.jpeg', label: '山水壁画' },
  { path: '/brand/backgrounds/法式植物建筑壁画ID_1150554437.jpeg', label: '法式植物' },
  { path: '/brand/backgrounds/浮雕.png', label: '浮雕' },
  { path: '/brand/backgrounds/现代壁纸_浅色丛林植物壁纸_风景壁纸_植物壁纸_热带雨林壁纸_壁布ID_1182178086.jpeg', label: '浅色丛林' },
  { path: '/brand/backgrounds/现代法式其他壁纸_现代法式其他壁纸_热带雨林文艺壁纸_法式热带雨林壁纸_热带雨林壁纸_花鸟壁纸ID_1203511809.jpeg', label: '法式雨林' },
  { path: '/brand/backgrounds/美式法式壁画_雨林壁画_植物壁画ID_1200386117.png', label: '雨林壁画' },
  { path: '/brand/backgrounds/现代其他玻璃_丝雾板磨砂_雾面_磨砂_透绿植氛围ID_1173927195.jpeg', label: '磨砂绿植' },
  { path: '/backgrounds/my-wallpaper.jpg', label: '桌面壁纸' },
] as const

export function isBuiltinBackdrop(path: string): boolean {
  return BUILTIN_BACKDROPS.some((item) => item.path === path)
}

export const TERMINAL_FONT_SUGGESTIONS = [
  'MesloLGS NF',
  'JetBrains Mono',
  'Cascadia Mono',
  'Fira Code',
  'Hack Nerd Font',
  'SF Mono',
  'Menlo',
  'Consolas',
] as const

const STORAGE_KEY = 'mirach:appearance.v1'
const CHAT_TEXT_DEFAULT_MIGRATION_KEY = 'mirach:appearance.chat-text-default-100.v1'
const DEFAULT_CHAT_TEXT_SCALE = 100

export interface AppearancePrefs {
  uiScale: number
  chatTextScale: number
  chatFont: string
  terminalFont: string
  introSplash: boolean
  backdrop: boolean
  userBubbleTransparency: number
  bubbleOutline: boolean
  accentColor: string
  textColor: string
  bottomWave: boolean
  backdropOpacity: number
  backdropImage: string
}

const DEFAULTS: AppearancePrefs = {
  uiScale: 100,
  chatTextScale: DEFAULT_CHAT_TEXT_SCALE,
  chatFont: '',
  terminalFont: '',
  introSplash: true,
  backdrop: false,
  userBubbleTransparency: 0,
  bubbleOutline: true,
  accentColor: '',
  textColor: '',
  bottomWave: false,
  backdropOpacity: 15,
  backdropImage: BUILTIN_BACKDROPS[0].path,
}

function matchPreset(value: unknown, presets: readonly number[], fallback: number): number {
  return presets.find((preset) => preset === Number(value)) ?? fallback
}

function normalize(raw: unknown): AppearancePrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULTS }
  const value = raw as Record<string, unknown>
  return {
    uiScale: matchPreset(value.uiScale, UI_SCALE_PRESETS, DEFAULTS.uiScale),
    chatTextScale: matchPreset(value.chatTextScale, CHAT_TEXT_SCALE_PRESETS, DEFAULTS.chatTextScale),
    chatFont: typeof value.chatFont === 'string' ? value.chatFont.trim() : '',
    terminalFont: typeof value.terminalFont === 'string' ? value.terminalFont.trim() : '',
    introSplash: typeof value.introSplash === 'boolean' ? value.introSplash : DEFAULTS.introSplash,
    backdrop: typeof value.backdrop === 'boolean' ? value.backdrop : DEFAULTS.backdrop,
    userBubbleTransparency:
      typeof value.userBubbleTransparency === 'number' && Number.isFinite(value.userBubbleTransparency)
        ? Math.min(100, Math.max(0, Math.round(value.userBubbleTransparency)))
        : DEFAULTS.userBubbleTransparency,
    bubbleOutline: typeof value.bubbleOutline === 'boolean' ? value.bubbleOutline : DEFAULTS.bubbleOutline,
    accentColor: typeof value.accentColor === 'string' ? value.accentColor.trim() : '',
    textColor: typeof value.textColor === 'string' ? value.textColor.trim() : '',
    bottomWave: typeof value.bottomWave === 'boolean' ? value.bottomWave : DEFAULTS.bottomWave,
    backdropOpacity:
      typeof value.backdropOpacity === 'number' && Number.isFinite(value.backdropOpacity)
        ? [5, 15, 30, 50, 100].includes(Math.round(value.backdropOpacity))
          ? Math.round(value.backdropOpacity)
          : DEFAULTS.backdropOpacity
        : DEFAULTS.backdropOpacity,
    backdropImage:
      typeof value.backdropImage === 'string' && value.backdropImage.trim()
        ? value.backdropImage.trim()
        : DEFAULTS.backdropImage,
  }
}

function readStored(): AppearancePrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const prefs = raw === null ? { ...DEFAULTS } : normalize(JSON.parse(raw))
    // 2026-11-23 用户定稿：聊天文字默认 100%（上游默认 110%）。首次读到
    // 旧默认值 110 的存档升到 100；之后用户手动选 110 不再覆盖。
    try {
      if (!localStorage.getItem(CHAT_TEXT_DEFAULT_MIGRATION_KEY)) {
        const before = prefs.chatTextScale
        if (prefs.chatTextScale === 110) prefs.chatTextScale = 100
        if (before !== prefs.chatTextScale) localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
        localStorage.setItem(CHAT_TEXT_DEFAULT_MIGRATION_KEY, '1')
      }
    } catch (e) {
      console.error('[appearance] 聊天文字默认值迁移标记写入失败', e)
    }
    return prefs
  } catch (e) {
    console.error('[appearance] 读取外观偏好失败——按默认值起步', e)
    return { ...DEFAULTS }
  }
}

function writeStored(prefs: AppearancePrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch (e) {
    console.error('[appearance] 保存外观偏好失败', e)
  }
}

function quoteSingleFamily(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function fontStack(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return ''
  const preferred =
    trimmed.includes(',') || /['"]/.test(trimmed) ? trimmed : quoteSingleFamily(trimmed)
  return `${preferred}, var(--font-family-default)`
}

/** 聊天字体 = 应用界面 + 聊天；终端字体只作用于 xterm 令牌。 */
function applyFonts(prefs: AppearancePrefs): void {
  const root = document.documentElement
  const chat = fontStack(prefs.chatFont)
  if (chat) {
    root.style.setProperty('--font-family', chat)
  } else {
    root.style.removeProperty('--font-family')
  }
  $chatFontFamily.set(prefs.chatFont)

  const terminal = prefs.terminalFont.trim()
  if (terminal) {
    root.style.setProperty('--term-font-family', terminal)
  } else {
    root.style.removeProperty('--term-font-family')
  }
}

function applyBubble(value: number): void {
  const root = document.documentElement
  if (value <= 0) {
    root.style.removeProperty('--user-bubble-keep')
  } else {
    root.style.setProperty('--user-bubble-keep', `${100 - value}%`)
  }
}

/** 主题色覆盖：空 = 跟随主题 primary；非空 = 标志/选中/发送钮统一用它。 */
function applyAccent(accentColor: string): void {
  const root = document.documentElement
  // 无主题基础外观不能读 --theme-primary：hermes-tokens 里它指向 --brand，
  // 清空自定义色后会读到上一次的 --brand（实测红值粘住）。基础品牌色固定
  // #006fff；有主题时才用当前皮肤的 primary。
  const themePrimary =
    root.dataset.hermesTheme === undefined
      ? ''
      : getComputedStyle(root).getPropertyValue('--theme-primary').trim()
  const accent = accentColor.trim() || themePrimary || '#006fff'
  const set = (name: string, value: string) => root.style.setProperty(name, value)
  set('--brand', accent)
  set('--primary', accent)
  set('--h2-color', accent)
  set('--logo-text-color', accent)
  set('--tab-text-active', accent)
  set('--tab-accent', accent)
  set('--fl-accent', accent)
  set('--width-handle-glow', accent)
  const logo = logoFilterFor(accent)
  set('--logo-hue-rotate', logo.hueRotate)
  set('--logo-saturate', logo.saturate)
}

/**
 * 文字颜色覆盖：空 = 跟随当前主题（applyHostTheme 每次换肤会重新写回）；
 * 非空 = 主文字/标签/正文统一用它。次级文字仍保留主题的弱化层级。
 */
function applyTextColor(textColor: string): void {
  const root = document.documentElement
  const names = ['--text', '--foreground', '--ui-text-primary', '--tab-text', '--h1-color', '--h3-color']
  const value = textColor.trim()
  // 无主题基础外观：空值必须交还给 tokens.css（含 .dark 暗色令牌），
  // 不能再写死 var(--theme-foreground,#000)，否则暗色模式会黑字黑底。
  if (!value && root.dataset.hermesTheme === undefined) {
    for (const name of names) root.style.removeProperty(name)
    return
  }
  const color = value || 'var(--theme-foreground, #000)'
  for (const name of names) root.style.setProperty(name, color)
}

/**
 * 聊天背景（2026-11-24 用户最终口径）：背景颜色不变，图铺在每栏容器上；
 * 5/15/30/50/100 档控制栏面保留多少实色（档位越高图越明显）。实现仍走
 * surface 令牌的 color-mix：--surface-base/--surface-shell-base 是主题实色，
 * 只按档位透出后面的 GlobalBackdrop。属性由 GlobalBackdrop 在图片 onLoad
 * 后挂 ready——加载失败时栏面保持实色，不会透明到桌面。
 */
function applyBackdropSurface(backdrop: boolean, opacity: number): void {
  const root = document.documentElement
  // 旧版可能把计算后的值直接写在根内联样式上；统一收回，改由 CSS 的
  // ready 选择器消费 --backdrop-*-keep，避免升级/HMR 残留。
  root.style.removeProperty('--surface')
  root.style.removeProperty('--surface-shell')
  if (!backdrop) {
    root.removeAttribute('data-mirach-backdrop')
    root.style.removeProperty('--backdrop-surface-keep')
    root.style.removeProperty('--backdrop-shell-keep')
    return
  }
  root.setAttribute('data-mirach-backdrop', '')
  const keep: Record<number, number> = { 5: 96, 15: 90, 30: 82, 50: 72, 100: 55 }
  const percent = keep[opacity] ?? keep[15]
  root.style.setProperty('--backdrop-surface-keep', `${percent}%`)
  root.style.setProperty('--backdrop-shell-keep', `${Math.max(45, percent - 8)}%`)
}

async function applyZoom(percent: number): Promise<void> {
  try {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    await getCurrentWebview().setZoom(percent / 100)
  } catch (e) {
    console.error('[appearance] 应用界面缩放失败', e)
  }
}

function applyPrefs(prefs: AppearancePrefs): void {
  if (typeof document === 'undefined') return
  document.documentElement.style.setProperty('--chat-text-scale', String(prefs.chatTextScale / 100))
  applyFonts(prefs)
  applyBubble(prefs.userBubbleTransparency)
  applyAccent(prefs.accentColor)
  applyTextColor(prefs.textColor)
  applyBackdropSurface(prefs.backdrop, prefs.backdropOpacity)
  void applyZoom(prefs.uiScale)
}

interface AppearanceState extends AppearancePrefs {
  setUiScale: (value: number) => void
  setChatTextScale: (value: number) => void
  setChatFont: (value: string) => void
  setTerminalFont: (value: string) => void
  setIntroSplash: (value: boolean) => void
  setBackdrop: (value: boolean) => void
  setUserBubbleTransparency: (value: number) => void
  setBubbleOutline: (value: boolean) => void
  setAccentColor: (value: string) => void
  setTextColor: (value: string) => void
  setBottomWave: (value: boolean) => void
  setBackdropOpacity: (value: number) => void
  setBackdropImage: (value: string) => void
  setFromStorage: () => void
}

export const appearanceStore = createStore<AppearanceState>((set, get) => {
  const patch = (next: Partial<AppearancePrefs>) => {
    const prefs = normalize({ ...get(), ...next })
    set({ ...prefs })
    writeStored(prefs)
    applyPrefs(prefs)
  }

  return {
    ...readStored(),
    setUiScale: (value) => patch({ uiScale: matchPreset(value, UI_SCALE_PRESETS, DEFAULTS.uiScale) }),
    setChatTextScale: (value) =>
      patch({ chatTextScale: matchPreset(value, CHAT_TEXT_SCALE_PRESETS, DEFAULTS.chatTextScale) }),
    setChatFont: (value) => patch({ chatFont: value }),
    setTerminalFont: (value) => patch({ terminalFont: value }),
    setIntroSplash: (value) => patch({ introSplash: value }),
    setBackdrop: (value) => patch({ backdrop: value }),
    setUserBubbleTransparency: (value) =>
      patch({ userBubbleTransparency: Math.min(100, Math.max(0, Math.round(value))) }),
    setBubbleOutline: (value) => patch({ bubbleOutline: value }),
    setAccentColor: (value) => patch({ accentColor: value }),
    setTextColor: (value) => patch({ textColor: value }),
    setBottomWave: (value) => patch({ bottomWave: value }),
    setBackdropOpacity: (value) =>
      patch({ backdropOpacity: [5, 15, 30, 50, 100].includes(Math.round(value)) ? Math.round(value) : DEFAULTS.backdropOpacity }),
    setBackdropImage: (value) => patch({ backdropImage: value }),
    setFromStorage: () => {
      const prefs = readStored()
      set({ ...prefs })
      applyPrefs(prefs)
    },
  }
})

/** 启动即应用（主窗与设置窗都 import 本模块）。 */
applyPrefs(appearanceStore.getState())

if (typeof window !== 'undefined') {
  // 两个窗口同源：改完设置窗立刻在主窗生效。
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) appearanceStore.getState().setFromStorage()
  })
  // 主题层退出到宿主基础外观时会清掉根内联变量；把字号/字体/主题色/
  // 文字色/背景等外观偏好重新写回，否则取消主题会把这些用户设置一起清掉。
  window.addEventListener('mirach:appearance-reapply', () => {
    applyPrefs(appearanceStore.getState())
  })
}

/** Ctrl/Cmd + / - / 0：与 hermes 的界面缩放快捷键同语义。 */
export function installAppearanceShortcuts(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return
    const current = appearanceStore.getState().uiScale
    const index = UI_SCALE_PRESETS.indexOf(current as UiScalePreset)
    if (event.key === '0') {
      event.preventDefault()
      appearanceStore.getState().setUiScale(100)
      return
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault()
      const next = UI_SCALE_PRESETS[Math.min(UI_SCALE_PRESETS.length - 1, (index < 0 ? 0 : index) + 1)]
      appearanceStore.getState().setUiScale(next)
      return
    }
    if (event.key === '-') {
      event.preventDefault()
      const next = UI_SCALE_PRESETS[Math.max(0, (index < 0 ? 0 : index) - 1)]
      appearanceStore.getState().setUiScale(next)
    }
  }
  window.addEventListener('keydown', onKeyDown, true)
  return () => window.removeEventListener('keydown', onKeyDown, true)
}
