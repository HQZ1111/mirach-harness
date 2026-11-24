/**
 * Desktop theme context.
 *
 * Applies the active theme as CSS custom properties on :root so every
 * Tailwind utility that references a color or font-family token picks up
 * the change automatically.
 *
 * Mode (light/dark/system) controls brightness; skin controls accent.
 * The two are persisted independently. Shift+X toggles light/dark.
 */

import { ensureContrast, mix, parseColor } from '@/hermes-mirror/shared/color'
import { useStore } from '@nanostores/react'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react'

import { logoFilterFor } from '@/lib/logo-tint'
import { $registryVersion } from '@/hermes-shim/contrib/registry'
import { matchesQuery, useMediaQuery } from '@/hermes-mirror/hooks/use-media-query'
import { persistString, persistStringRecord, storedString, storedStringRecord } from '@/hermes-mirror/lib/storage'
import { recordFeatureUse } from '@/hermes-shim/store/desktop-metrics'
import { $activeGatewayProfile, normalizeProfileKey } from '@/hermes-shim/store/profile'
import { $connection } from '@/hermes-shim/store/session'
import { setAppearance } from '@/hermes-shim/store/translucency'

import { $accentOverride } from './accent-override'
import {
  $backendCustomCSS,
  $backendThemes,
  $pendingSkinApply,
  localDisplaySkinName,
  localDisplaySkinProfile
} from './backend-sync'
import { $chatFontFamily, resolveChatFontFamily } from './chat-font'
import { harmonize, normalizeHex, readableInk } from './color'
import { BUILTIN_THEME_LIST, DEFAULT_SKIN_NAME, DEFAULT_TYPOGRAPHY, nousTheme, RETIRED_SKINS } from './presets'
import { $pendingModeApply } from './request'
import { retintTheme } from './retint'
import type { DesktopTheme, DesktopThemeColors, DesktopThemeTypography } from './types'
import { $userThemes, listAllThemes, resolveTheme } from './user-themes'

// Legacy global skin (pre per-profile themes). Still the inheritance fallback
// for any profile without its own assignment, so single-profile users and old
// installs are unaffected.
const SKIN_KEY = 'hermes-desktop-theme-v2'
const MODE_KEY = 'hermes-desktop-mode-v1'
// Per-profile skin + light/dark mode assignments: { [profileKey]: value }. A
// profile inherits the global default until it's given its own appearance.
const PROFILE_SKINS_KEY = 'hermes-desktop-profile-themes-v1'
const PROFILE_MODES_KEY = 'hermes-desktop-profile-modes-v1'
// Last active profile, recorded so the boot-time paint can pick that profile's
// theme before the gateway reports which profile actually launched.
const LAST_PROFILE_KEY = 'hermes-desktop-active-profile-v1'

export type ThemeMode = 'light' | 'dark' | 'system'

/** 2026-11-24 用户："去掉默认，再次点击取消选择主题，恢复之前没加主题
 *  系统时候的样子"。这个哨兵皮肤不渲染任何主题，只保留 tokens.css 的
 *  宿主基础令牌；它不出现在画廊里，点击已选主题时写入它。 */
export const HOST_THEME_NONE = '__host__'

/** applyTheme 曾经写过的根内联变量，退出主题时逐个 removeProperty。 */
const APPLIED_THEME_PROPS = new Set<string>()

const INJECTED_FONT_URLS = new Set<string>()

const resolveMode = (mode: ThemeMode, systemDark = matchesQuery('(prefers-color-scheme: dark)')): 'light' | 'dark' =>
  mode === 'system' ? (systemDark ? 'dark' : 'light') : mode

const normalizeSkin = (name: string | null): string =>
  name === HOST_THEME_NONE
    ? HOST_THEME_NONE
    : name === DEFAULT_SKIN_NAME
      ? // "默认"不再是一个可选皮肤：旧存档里的 nous 迁到无主题基础外观。
        HOST_THEME_NONE
      : name && resolveTheme(name) && !RETIRED_SKINS.has(name)
        ? name
        : HOST_THEME_NONE

/**
 * A stored mode, or `light` when there isn't one.
 *
 * 宿主历史只有浅色壳（此前 boot paint 固定 light）；外观页接上明暗切换后，
 * 全新安装的默认必须保持既有观感——否则 OS 暗色用户第一次启动就整窗变黑，
 * 而用户从未选过暗色。需要跟随系统时在「外观 → 主题」里显式选「跟随系统」。
 */
const normalizeMode = (value: string | null): ThemeMode =>
  value === 'light' || value === 'dark' || value === 'system' ? value : 'light'

// ─── Per-profile appearance persistence ─────────────────────────────────────
// Skin and mode are each stored per profile. "default" isn't a real profile —
// it *is* the legacy global slot, so it reads/writes the global directly. Named
// profiles get their own entry and fall back to that global until assigned, so
// unassigned profiles and pre-per-profile installs stay on the global value.
// Named assigns also mirror into the global slot so a Bot Mode gateway hop onto
// a never-themed bot inherits the look the user just picked (#101216).
// Persists from stored (write-on-read). Idempotent. No-op when records disagree.
const promoteUnanimousLegacy = (record: string, legacy: string): void => {
  if (storedString(legacy) != null) {
    return
  }

  const values = Object.values(storedStringRecord(record)).filter(Boolean)

  if (values.length === 0) {
    return
  }

  const unique = [...new Set(values)]

  if (unique.length === 1) {
    persistString(legacy, unique[0])
  }
}

const profilePref = <T extends string>(record: string, legacy: string, normalize: (v: string | null) => T) => {
  const stored = (profile: string): string | null => {
    promoteUnanimousLegacy(record, legacy)

    return storedStringRecord(record)[profile] ?? storedString(legacy)
  }

  return {
    /** The pick as written, un-normalized. */
    stored,
    resolve: (profile: string): T => normalize(stored(profile)),
    assign: (profile: string, value: T): void => {
      if (profile === 'default') {
        persistString(legacy, value)
      } else {
        persistStringRecord(record, { ...storedStringRecord(record), [profile]: value })
        persistString(legacy, value)
      }
    }
  }
}

export const skinPref = profilePref(PROFILE_SKINS_KEY, SKIN_KEY, normalizeSkin)
export const modePref = profilePref(PROFILE_MODES_KEY, MODE_KEY, normalizeMode)

// The bridge's local skin is only a fallback for the profile this window booted
// into. A desktop-side pick remains the source of truth, and switching to a
// different profile cannot borrow a skin from this machine's initial profile.
const readBootProfileKey = () => normalizeProfileKey(storedString(LAST_PROFILE_KEY))
const BOOT_PROFILE_KEY = typeof window === 'undefined' ? 'default' : (localDisplaySkinProfile ?? readBootProfileKey())

// Provider state keeps the raw pick so a name nothing resolves YET (a backend
// skin the gateway hasn't seeded on this launch) isn't flattened to the default
// for the rest of the session — it paints as soon as the registry can resolve it.
const storedSkin = (profile: string): string =>
  skinPref.stored(profile) ??
  (profile === BOOT_PROFILE_KEY ? (localDisplaySkinName ?? HOST_THEME_NONE) : HOST_THEME_NONE)

/** The live profile's committed theme: what the ThemeProvider paints without a preview. */
export const committedTheme = (): DesktopTheme =>
  resolveTheme(normalizeSkin(storedSkin(normalizeProfileKey($activeGatewayProfile.get())))) ?? nousTheme

/** Everything a peer window could change that this one has to repaint for. */
const APPEARANCE_KEYS = new Set([SKIN_KEY, PROFILE_SKINS_KEY, MODE_KEY, PROFILE_MODES_KEY])

const rememberActiveProfileKey = (profile: string) => persistString(LAST_PROFILE_KEY, profile)

// ─── Color math (for synthesised light variants of dark-only skins) ────────
// mix / ensureContrast live in @hermes/shared/color (shared with the TUI);
// readableInk in ./color pins the desktop's near-black ink.

function synthLightColors(seed: DesktopTheme): DesktopThemeColors {
  const accent = seed.colors.ring || seed.colors.primary
  const soft = mix('#ffffff', accent, 0.1)
  const softer = mix('#ffffff', accent, 0.06)
  const border = mix('#ececef', accent, 0.14)
  const midground = seed.colors.midground ?? accent

  return {
    background: '#ffffff',
    foreground: '#161616',
    card: '#ffffff',
    cardForeground: '#161616',
    muted: softer,
    mutedForeground: mix('#6b6b70', accent, 0.16),
    popover: '#ffffff',
    popoverForeground: '#161616',
    primary: accent,
    primaryForeground: readableInk(accent),
    secondary: soft,
    secondaryForeground: mix('#2a2a2a', accent, 0.34),
    accent: soft,
    accentForeground: mix('#2a2a2a', accent, 0.34),
    border,
    input: mix('#e2e2e6', accent, 0.18),
    ring: accent,
    midground,
    midgroundForeground: readableInk(midground),
    destructive: '#b94a3a',
    destructiveForeground: '#ffffff',
    sidebarBackground: mix('#fafafa', accent, 0.05),
    sidebarBorder: border,
    userBubble: soft,
    userBubbleBorder: border
  }
}

/** Returns the seed palette for a given skin + mode (no overrides applied). */
export function getBaseColors(skinName: string, mode: 'light' | 'dark'): DesktopThemeColors {
  return paletteFor(resolveTheme(skinName) ?? nousTheme, mode)
}

function paletteFor(seed: DesktopTheme, mode: 'light' | 'dark'): DesktopThemeColors {
  if (mode === 'dark') {
    return seed.darkColors ?? seed.colors
  }

  return seed.darkColors ? seed.colors : synthLightColors(seed)
}

// A backend skin named `default`/`mono`/… keeps the desktop's own palette
// (never shadowed — see ingestBackendSkin), but its customCSS is carried
// separately in $backendCustomCSS. The seed's own customCSS (non-built-in
// backend skins) wins when both exist.
const customCSSOf = (seed: DesktopTheme): string | undefined => seed.customCSS ?? $backendCustomCSS.get()[seed.name]

function deriveFrom(seed: DesktopTheme, mode: 'light' | 'dark'): DesktopTheme {
  return {
    ...seed,
    name: `${seed.name}-${mode}`,
    label: `${seed.label} ${mode === 'light' ? 'Light' : 'Dark'}`,
    description: `${seed.label} ${mode} palette`,
    colors: paletteFor(seed, mode),
    customCSS: customCSSOf(seed)
  }
}

const deriveTheme = (skinName: string, mode: 'light' | 'dark'): DesktopTheme =>
  deriveFrom({ ...(resolveTheme(skinName) ?? nousTheme), name: skinName }, mode)

/** The theme a saved accent was retinted from; any other theme is its own base. */
export const accentBase = (theme: DesktopTheme): DesktopTheme =>
  (theme.accentOf && resolveTheme(theme.accentOf)) || theme

/**
 * `theme` with only its accent moved to `accent`, both modes painted exactly as the live accent preview
 * paints them. Every other colour and the CSS stay the base's. One `<base>-accent-<hex>` copy per base and
 * colour: user themes are shared by every profile, so a copy per base alone let one profile's accent
 * overwrite another's. The base's own accent returns the base itself.
 */
export function accentedTheme(theme: DesktopTheme, accent: string): DesktopTheme {
  const base = accentBase(theme)
  const hex = normalizeHex(accent)

  if (!hex || hex === normalizeHex(base.colors.primary)) {
    return base
  }

  const tint = (mode: 'light' | 'dark') => retintTheme({ ...base, colors: paletteFor(base, mode) }, hex).colors

  return {
    ...base,
    name: `${base.name}-accent-${hex.slice(1)}`,
    label: `${base.label} · ${hex}`,
    accentOf: base.name,
    colors: tint('light'),
    darkColors: tint('dark'),
    customCSS: customCSSOf(base)
  }
}

/**
 * Some palettes intentionally keep a bright background even when
 * `mode === 'dark'`, so we shouldn't apply the `.dark` class. Decide from
 * the actual background luminance.
 */
function renderedModeFor(colors: DesktopThemeColors, mode: 'light' | 'dark'): 'light' | 'dark' {
  const rgb = parseColor(colors.background)

  if (!rgb) {
    return mode
  }

  const [r, g, b] = rgb.map(v => v / 255)

  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? 'light' : 'dark'
}

// ─── CSS application ────────────────────────────────────────────────────────

// Per-mode mix knobs. Light/dark fallbacks live in styles.css `:root` /
// `:root.dark`; setting them inline keeps active-skin overrides surviving
// the boot-time paint.
// styles.css --theme-neutral-chrome — keep in sync.
const NEUTRAL_CHROME = { light: '#f3f3f3', dark: '#0d0d0e' } as const

// The one foreground --dt-primary-solid is built to carry. Fixed rather than
// measured: the surface is derived to suit IT, not the other way round.
// styles.css --dt-primary-solid-foreground fallback — keep in sync.
const PRIMARY_SOLID_FOREGROUND = '#fcfcfc'

const chromeBackground = (background: string, isDark: boolean) =>
  mix(background, NEUTRAL_CHROME[isDark ? 'dark' : 'light'], isDark ? 0.26 : 0.08)

const mixesFor = (isDark: boolean): Record<string, string> => ({
  '--theme-mix-chrome': isDark ? '74%' : '92%',
  '--theme-mix-sidebar': '100%',
  '--theme-mix-card': isDark ? '38%' : '22%',
  '--theme-mix-elevated': isDark ? '46%' : '28%',
  '--theme-mix-bubble': isDark ? '46%' : '0%'
})

const TYPOGRAPHY_KNOB_VARS = {
  baseSize: '--dt-base-size',
  lineHeight: '--dt-line-height',
  letterSpacing: '--dt-letter-spacing'
} as const

// Optional typography knobs. They are the ONLY vars applyTheme may paint
// inline conditionally: styles.css declares the same fallbacks on :root, so
// a theme that stops providing one must drop the inline value — otherwise
// the previous skin's size/leading/tracking sticks across a switch (#41766).
function applyTypographyKnobs(root: HTMLElement, typo: Partial<DesktopThemeTypography>) {
  for (const [key, cssVar] of Object.entries(TYPOGRAPHY_KNOB_VARS) as [keyof typeof TYPOGRAPHY_KNOB_VARS, string][]) {
    const value = typo[key]

    if (value) {
      APPLIED_THEME_PROPS.add(cssVar)
      root.style.setProperty(cssVar, value)
    } else {
      root.style.removeProperty(cssVar)
    }
  }
}

/** 外观 → 主题色（空 = 跟随皮肤 primary）。主题上下文直接读存档，避免
 *  context ⇄ appearance store 的循环依赖。 */
function accentOverride(): string {
  try {
    const raw = window.localStorage.getItem('mirach:appearance.v1')
    if (!raw) return ''
    const parsed = JSON.parse(raw) as { accentColor?: unknown }
    return typeof parsed.accentColor === 'string' ? parsed.accentColor.trim() : ''
  } catch {
    return ''
  }
}

/** 外观 → 文字颜色（空 = 跟随皮肤 foreground）。同样从存档直读，避免循环依赖。 */
function textColorOverride(): string {
  try {
    const raw = window.localStorage.getItem('mirach:appearance.v1')
    if (!raw) return ''
    const parsed = JSON.parse(raw) as { textColor?: unknown }
    return typeof parsed.textColor === 'string' ? parsed.textColor.trim() : ''
  } catch {
    return ''
  }
}

/**
 * 把 hermes 皮肤色映射到宿主壳令牌（2026-11-23 用户："默认的所有主题都没
 * 生效"）。ThemeProvider 原本只写 `--dt-*`/`--theme-*`，宿主自定义的
 * `--text/--surface/--brand/...` 仍是编译期浅色，所以换皮肤看起来没反应。
 * 这里每次 applyTheme 都把宿主语义令牌同步成同一套颜色；hover/选中统一
 * 为主题色浅蓝（8%/14% 透明度），标志/页签/发送钮用主题色（或用户选的
 * 自定义主题色）。
 */
function applyHostTheme(root: HTMLElement, c: DesktopThemeColors, isDark: boolean) {
  const accent = accentOverride()
  const brand = accent || c.primary
  const mix = (color: string, percent: number, base = 'transparent') =>
    `color-mix(in srgb, ${color} ${percent}%, ${base})`
  const set = (name: string, value: string | undefined | null) => {
    if (value) {
      APPLIED_THEME_PROPS.add(name)
      root.style.setProperty(name, value)
    }
  }

  set('--brand', brand)
  set('--logo-text-color', brand)
  set('--h2-color', brand)
  set('--tab-text-active', brand)
  set('--tab-accent', brand)
  set('--fl-accent', brand)
  set('--width-handle-glow', brand)
  const logoFilter = logoFilterFor(brand)
  set('--logo-hue-rotate', logoFilter.hueRotate)
  set('--logo-saturate', logoFilter.saturate)

  set('--text', c.foreground)
  set('--text-2', c.mutedForeground)
  set('--text-3', mix(c.mutedForeground, 80, c.background))
  set('--text-4', mix(c.mutedForeground, 60, c.background))
  set('--h1-color', c.foreground)
  set('--h3-color', c.foreground)

  set('--surface-base', c.card)
  set('--surface-shell-base', c.sidebarBackground ?? c.background)
  set('--background', c.background)
  set('--foreground', c.foreground)
  set('--card', c.card)
  set('--card-foreground', c.cardForeground)
  set('--popover', c.popover)
  set('--popover-foreground', c.popoverForeground)
  set('--primary', brand)
  set('--primary-foreground', c.primaryForeground)
  set('--secondary', c.secondary)
  set('--secondary-foreground', c.secondaryForeground)
  set('--muted', c.muted)
  set('--muted-foreground', c.mutedForeground)
  set('--accent', isDark ? '#1e3a5f' : '#eff6ff')
  set('--accent-foreground', c.foreground)
  set('--border', c.border)
  set('--input', c.input ?? c.border)
  set('--ring', brand)
  set('--sidebar', c.sidebarBackground ?? c.background)
  set('--sidebar-foreground', c.foreground)
  set('--sidebar-primary', brand)
  set('--sidebar-primary-foreground', c.primaryForeground)
  set('--sidebar-accent', mix(brand, 10, c.background))
  set('--sidebar-accent-foreground', c.foreground)
  set('--sidebar-border', c.sidebarBorder ?? c.border)
  set('--sidebar-ring', brand)

  set('--stroke', c.border)
  set('--stroke-soft', mix(c.border, 68))
  set('--scale-gray-a1', mix(c.foreground, 3))
  set('--scale-gray-a2', mix(c.foreground, 5))
  set('--scale-gray-a3', mix(c.foreground, 8))
  set('--scale-gray-a4', mix(c.foreground, 12))
  set('--scale-gray-a5', mix(c.foreground, 18))
  set('--scale-gray-a6', mix(c.foreground, 24))

  set('--tab-text', c.foreground)
  set('--tab-active-bg', c.card)
  set('--tab-hover-bg', 'var(--hover-wash)')
  set('--tab-separator', mix(c.foreground, 10))
  set('--tab-dot-color', c.mutedForeground)
  set('--tab-accent-wash', 'var(--select-wash)')

  set('--code-bg', c.muted)
  set('--code-border', c.border)
  set('--term-bg', c.background)
  set('--term-fg', c.foreground)
  set('--term-cursor', c.foreground)
  set('--term-cursor-accent', c.background)
  set('--term-white', c.foreground)
  set('--term-black', c.mutedForeground)

  // 宿主/镜像共用的 --ui-* 别名（弹层、列表、bot 页）。
  set('--ui-bg-quinary', 'var(--hover-wash)')
  set('--ui-bg-quaternary', mix(c.foreground, 5))
  set('--ui-bg-tertiary', mix(c.foreground, 3))
  set('--ui-row-active-background', 'var(--select-wash)')
  set('--ui-row-hover-background', 'var(--hover-wash)')
  set('--ui-text-primary', c.foreground)
  set('--ui-text-secondary', c.mutedForeground)
  set('--ui-text-tertiary', mix(c.mutedForeground, 80, c.background))
  set('--ui-text-quaternary', mix(c.mutedForeground, 60, c.background))
  set('--ui-stroke-secondary', c.border)
  set('--ui-stroke-tertiary', mix(c.border, 68))
  set('--ui-control-hover-background', 'var(--hover-wash)')
  set('--ui-control-active-background', 'var(--select-wash)')
  set('--ui-chat-surface-background', c.card)
  set('--ui-chat-bubble-background', c.card)
  set('--ui-sidebar-surface-background', c.sidebarBackground ?? c.card)
  set('--ui-editor-surface-background', c.card)
  set('--ui-chat-bubble-opaque-background', c.card)
  set('--theme-mix-chrome', isDark ? '74%' : '92%')
  set('--theme-mix-card', isDark ? '38%' : '22%')
  set('--theme-mix-elevated', isDark ? '46%' : '28%')
  set('--theme-mix-bubble', isDark ? '46%' : '0%')

  // 外观 → 文字颜色：用户明确选了颜色时覆盖皮肤的主文字（次级文字仍用
  // 皮肤弱化层级）。空 = 不覆盖，上面已经写了主题自己的值。
  const text = textColorOverride()
  if (text) {
    for (const name of ['--text', '--foreground', '--ui-text-primary', '--tab-text', '--h1-color', '--h3-color']) {
      root.style.setProperty(name, text)
    }
  }
}

function applyTheme(theme: DesktopTheme, mode: 'light' | 'dark', chatFontFamily = $chatFontFamily.get()) {
  if (typeof document === 'undefined') {
    return
  }

  const root = document.documentElement
  const c = theme.colors
  const typo = { ...DEFAULT_TYPOGRAPHY, ...nousTheme.typography, ...theme.typography }
  const rendered = renderedModeFor(c, mode)
  const isDark = rendered === 'dark'
  const midground = c.midground ?? c.ring
  const skinName = theme.name.endsWith(`-${mode}`) ? theme.name.slice(0, -mode.length - 1) : theme.name

  root.style.setProperty('color-scheme', rendered)
  root.dataset.hermesTheme = skinName
  root.dataset.hermesMode = rendered
  root.classList.toggle('dark', isDark)

  // Translucency is tuned per appearance, and "appearance" means the palette
  // actually painted — a skin that keeps a bright surface in "dark" wants
  // light's tint. Publishing from here covers the boot paint too, so the very
  // first resolved state main is told about is already the right one.
  setAppearance(rendered)

  // Brand seeds feed every glass + shadcn token via `color-mix()` in styles.css.
  const seeds: Record<string, string> = {
    '--theme-foreground': c.foreground,
    '--theme-primary': c.primary,
    '--theme-secondary': c.secondary,
    '--theme-accent-soft': c.accent,
    '--theme-midground': midground,
    '--theme-warm': c.primary,
    '--theme-background-seed': c.background,
    '--theme-sidebar-seed': c.sidebarBackground ?? c.background,
    '--theme-card-seed': c.card,
    '--theme-elevated-seed': c.popover,
    '--theme-bubble-seed': c.userBubble ?? c.popover
  }

  // shadcn/Tailwind tokens that aren't derived from the seed chain.
  const palette: Record<string, string> = {
    '--dt-primary-foreground': c.primaryForeground,
    '--dt-secondary-foreground': c.secondaryForeground,
    '--dt-accent-foreground': c.accentForeground,
    '--dt-border': c.border,
    '--dt-input': c.input,
    '--dt-ring': c.ring,
    '--dt-muted': c.muted,
    '--dt-midground-foreground': c.midgroundForeground ?? readableInk(midground),
    // A LOUD fill of the brand colour, for the rare surface that has to read as
    // the app speaking rather than as chrome. `primary` alone can't do that job:
    // a pale accent (imported VS Code themes love a pastel pink) is a perfectly
    // valid primary, and the honest `primaryForeground` for it is near-black —
    // so the "loud" surface comes out a pastel card with dark text on it,
    // whispering. Deepening the hue until the LIGHT foreground clears AA keeps
    // one look across every theme: no-ops on an accent that is already deep,
    // and only ever darkens, so the hue survives.
    '--dt-primary-solid': ensureContrast(c.primary, PRIMARY_SOLID_FOREGROUND, 4.5),
    '--dt-primary-solid-foreground': PRIMARY_SOLID_FOREGROUND,
    '--dt-composer-ring': c.composerRing ?? midground,
    '--dt-destructive': c.destructive,
    '--dt-destructive-foreground': c.destructiveForeground,
    '--dt-sidebar-border': c.sidebarBorder ?? c.border,
    '--dt-user-bubble-border': c.userBubbleBorder ?? c.border,
    // Semantic success, bent toward the accent so it settles into the palette
    // instead of clashing with it. A green accent barely moves it (see
    // `harmonize`); a blue one turns the sidebar's finished dots teal rather
    // than leaving eight emerald spots fighting the theme.
    '--ui-success': harmonize('#10b981', midground, 0.25),
    '--dt-font-sans': resolveChatFontFamily(chatFontFamily, typo.fontSans),
    '--dt-font-mono': typo.fontMono,
    '--noise-opacity-mul': isDark ? 'calc(0.04 / 0.21)' : 'calc(0.34 / 0.21)'
  }

  for (const [k, v] of Object.entries({ ...seeds, ...mixesFor(isDark), ...palette })) {
    APPLIED_THEME_PROPS.add(k)
    root.style.setProperty(k, v)
  }

  applyTypographyKnobs(root, typo)
  applyHostTheme(root, c, isDark)

  const chromeBg = chromeBackground(c.background, isDark)

  window.hermesDesktop?.setTitleBarTheme?.({
    background: chromeBg,
    foreground: c.foreground
  })

  // Raw (non-JSON) keys read by the inline pre-paint script in index.html —
  // they let a brand-new window paint the themed background on its very first
  // frame, before this module has even loaded.
  try {
    window.localStorage.setItem('hermes-boot-background', chromeBg)
    window.localStorage.setItem('hermes-boot-color-scheme', rendered)
  } catch {
    // Storage may be unavailable (private mode / quota); the inline script
    // falls back to prefers-color-scheme.
  }

  if (typo.fontUrl && !INJECTED_FONT_URLS.has(typo.fontUrl)) {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = typo.fontUrl
    link.dataset.hermesThemeFont = 'true'
    document.head.appendChild(link)
    INJECTED_FONT_URLS.add(typo.fontUrl)
  }

  // Inject / clear customCSS from the skin (mirrors web/src/themes/context.tsx).
  // A theme carries the optional customCSS field; we inject/remove a single
  // <style> tag to keep the DOM clean and avoid stale rules on switch.
  const cssId = 'hermes-desktop-custom-css'
  let cssEl = document.getElementById(cssId) as HTMLStyleElement | null
  const customCSS = theme.customCSS?.trim()

  if (!customCSS) {
    if (cssEl) {
      cssEl.remove()
    }
  } else {
    if (!cssEl) {
      cssEl = document.createElement('style')
      cssEl.id = cssId
      cssEl.dataset.hermesSkinCSS = 'true'
      document.head.appendChild(cssEl)
    }

    cssEl.textContent = customCSS
  }
}

/**
 * 退出主题系统：把 applyTheme 写过的根内联变量全部撤回，只留下
 * tokens.css 的宿主基础外观（2026-11-24 用户："恢复之前没加主题系统时候
 * 的样子"）。明暗仍按 mode 走宿主已有的 `.dark` 令牌；随后通知外观偏好
 * 层重新应用字号/主题色/文字色/背景，避免把用户自选项一起清掉。
 */
function applyHostBase(mode: 'light' | 'dark') {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  for (const name of APPLIED_THEME_PROPS) root.style.removeProperty(name)
  APPLIED_THEME_PROPS.clear()
  root.style.setProperty('color-scheme', mode)
  root.classList.toggle('dark', mode === 'dark')
  delete root.dataset.hermesTheme
  root.dataset.hermesMode = mode
  document.getElementById('hermes-desktop-custom-css')?.remove()
  setAppearance(mode)

  const bg = mode === 'dark' ? '#111114' : '#e9eeef'
  window.hermesDesktop?.setTitleBarTheme?.({ background: bg, foreground: mode === 'dark' ? '#f4f4f5' : '#000000' })
  try {
    window.localStorage.setItem('hermes-boot-background', bg)
    window.localStorage.setItem('hermes-boot-color-scheme', mode)
  } catch {
    // localStorage 不可用时只影响下一帧预涂色，不影响当前外观。
  }

  // appearance-prefs 在该模块加载时已注册监听；启动阶段它尚未加载时，
  // 之后自己的 applyPrefs 会补上。
  window.dispatchEvent(new Event('mirach:appearance-reapply'))
}

// Pin Electron's nativeTheme to the app's mode so the NATIVE window chrome
// (macOS vibrancy material, titlebar, pre-paint background) matches the app
// theme instead of the OS appearance. An explicit light/dark pick is forced;
// 'system' stays 'system' so prefers-color-scheme keeps tracking the OS.
const syncNativeTheme = (pref: ThemeMode, rendered: 'light' | 'dark') =>
  window.hermesDesktop?.setNativeTheme?.(pref === 'system' ? 'system' : rendered)

// Boot-time paint to avoid a flash before <ThemeProvider> mounts. Use the last
// active profile's appearance so a non-default profile relaunch paints its own
// skin + light/dark mode.
//
// 2026-11-23：宿主补齐了 `.dark` 令牌（tokens.css），主题层不再固定 light；
// 这里按已保存的 mode 解析（system 跟随 OS），与 <ThemeProvider> 运行时一致。
if (typeof window !== 'undefined') {
  const profile = BOOT_PROFILE_KEY
  const storedMode = modePref.resolve(profile)
  const resolved = storedMode === 'system' ? (matchesQuery('(prefers-color-scheme: dark)') ? 'dark' : 'light') : storedMode
  const bootSkin = normalizeSkin(storedSkin(profile))
  if (bootSkin === HOST_THEME_NONE) {
    applyHostBase(resolved)
  } else {
    const theme = deriveTheme(bootSkin, resolved)
    applyTheme(theme, resolved)
    syncNativeTheme(storedMode, renderedModeFor(theme.colors, resolved))
  }
}

// ─── Context ────────────────────────────────────────────────────────────────

interface ThemeContextValue {
  theme: DesktopTheme
  themeName: string
  mode: ThemeMode
  /** The light/dark switch the user picked. */
  resolvedMode: 'light' | 'dark'
  /**
   * The mode actually painted, derived from the active background's luminance.
   * Differs from `resolvedMode` for skins that keep a bright surface in "dark"
   * (or vice-versa). Surface-bound UI (e.g. the terminal palette) should key off
   * this so it matches what's on screen instead of inverting.
   */
  renderedMode: 'light' | 'dark'
  availableThemes: Array<{ name: string; label: string; description: string }>
  setTheme: (name: string) => void
  setMode: (mode: ThemeMode) => void
  /**
   * Paint a theme with an explicit light/dark, without persistence. This is
   * the highlight preview for the palette. A commit (`setTheme`) or
   * `clearThemePreview` repaints the committed appearance.
   */
  previewTheme: (name: string, mode: 'light' | 'dark') => void
  clearThemePreview: () => void
}

const SKIN_LIST = BUILTIN_THEME_LIST.map(({ name, label, description }) => ({ name, label, description }))

const ThemeContext = createContext<ThemeContextValue>({
  theme: nousTheme,
  themeName: HOST_THEME_NONE,
  mode: 'light',
  resolvedMode: 'light',
  renderedMode: 'light',
  availableThemes: SKIN_LIST,
  setTheme: () => {},
  setMode: () => {},
  previewTheme: () => {},
  clearThemePreview: () => {}
})

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Skin + mode are assigned per profile; the active profile drives which
  // appearance shows. Single-profile users only ever see "default", so their
  // behavior is unchanged.
  const activeGatewayProfile = useStore($activeGatewayProfile)
  const connection = useStore($connection)
  // Before a gateway descriptor exists, the bridge is the only authoritative
  // profile for this window. Once one arrives, follow the live route as usual.
  const profileKey = normalizeProfileKey(connection?.profile ?? (connection ? activeGatewayProfile : BOOT_PROFILE_KEY))

  // Built-ins + user-installed + registry-contributed themes. Reactive so an
  // import or a plugin registration shows up live in the palette, settings
  // grid, and `/skin` without a reload.
  const userThemes = useStore($userThemes)
  const backendThemes = useStore($backendThemes)
  const backendCustomCSS = useStore($backendCustomCSS)
  const registryVersion = useStore($registryVersion)

  const availableThemes = useMemo(
    () =>
      listAllThemes().map(({ name, label, description }) => ({
        name,
        label,
        description
      })),
    // userThemes + backendThemes + registryVersion ARE listAllThemes' reactivity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userThemes, backendThemes, registryVersion]
  )

  const [themeName, setThemeNameState] = useState(() =>
    typeof window === 'undefined' ? DEFAULT_SKIN_NAME : storedSkin(BOOT_PROFILE_KEY)
  )

  const [mode, setModeState] = useState<ThemeMode>(() =>
    typeof window === 'undefined' ? 'system' : modePref.resolve(BOOT_PROFILE_KEY)
  )

  // Follow profile switches: paint the profile's assigned skin + mode and
  // remember it for the next boot's first paint.
  useEffect(() => {
    rememberActiveProfileKey(profileKey)
    setThemeNameState(storedSkin(profileKey))
    setModeState(modePref.resolve(profileKey))
  }, [profileKey])

  // Appearance is per-profile localStorage, and every desktop window is another
  // renderer on the same origin — so a switch made in the HUD (or any peer
  // window) only ever repainted the window it was made in. `storage` fires in
  // the OTHER windows, which is exactly the set that needs to catch up.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key && !APPEARANCE_KEYS.has(event.key)) {
        return
      }

      const live = normalizeProfileKey($activeGatewayProfile.get())

      setThemeNameState(storedSkin(live))
      setModeState(modePref.resolve(live))
    }

    window.addEventListener('storage', onStorage)

    return () => window.removeEventListener('storage', onStorage)
  }, [])

  const systemDark = useMediaQuery('(prefers-color-scheme: dark)')
  const resolvedMode = resolveMode(mode, systemDark)

  // Transient highlight preview (palette theme picker). It is never
  // persisted. A commit or an explicit clear returns the paint to the
  // committed appearance.
  const [preview, setPreview] = useState<{ name: string; mode: 'light' | 'dark' } | null>(null)

  // The committed skin, resolved against the CURRENT registry — so a stored
  // backend skin that failed to resolve at boot paints once the gateway seeds it.
  const committedName = useMemo(
    () => normalizeSkin(themeName),
    // normalizeSkin resolves through the merged registry; the stores are its reactivity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [themeName, userThemes, backendThemes, registryVersion]
  )

  const paintedName = preview ? preview.name : committedName
  const paintedMode = preview ? preview.mode : resolvedMode

  const isHostBase = paintedName === HOST_THEME_NONE

  const activeTheme = useMemo(
    () => (isHostBase ? nousTheme : deriveTheme(paintedName, paintedMode)),
    // deriveTheme resolves its seed through the merged registry, so the theme
    // stores are its reactivity too — an in-place palette edit of the ACTIVE
    // skin (live theme authoring) must repaint, not just a name switch. The
    // backend CSS store matters the same way for built-in-named user skins.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isHostBase, paintedName, paintedMode, userThemes, backendThemes, backendCustomCSS, registryVersion]
  )

  // Unsaved accent preview (dev picker, onboarding accent card). `null` returns
  // the theme untouched.
  const accentOverride = useStore($accentOverride)

  // Painted from the same theme persistAccent saves, so committing the accent changes nothing on screen.
  const paintedTheme = useMemo(
    () =>
      isHostBase
        ? nousTheme
        : accentOverride === null
          ? activeTheme
          : deriveFrom(accentedTheme(resolveTheme(paintedName) ?? nousTheme, accentOverride), paintedMode),
    [activeTheme, accentOverride, isHostBase, paintedName, paintedMode]
  )

  // What actually gets painted (matches the `.dark` class applyTheme toggles).
  const renderedMode = useMemo(
    () => (isHostBase ? paintedMode : renderedModeFor(paintedTheme.colors, paintedMode)),
    [isHostBase, paintedTheme, paintedMode],
  )

  // The chat face rides on the theme paint: the config-backed family is layered
  // in front of the theme's own stack, so an empty value is exactly the theme.
  const chatFontFamily = useStore($chatFontFamily)

  useEffect(() => {
    if (isHostBase) applyHostBase(paintedMode)
    else applyTheme(paintedTheme, paintedMode, chatFontFamily)
  }, [isHostBase, paintedTheme, paintedMode, chatFontFamily])

  // Keep the native window appearance pinned to the app theme (vibrancy
  // material, titlebar, new-window pre-paint background).
  useEffect(() => syncNativeTheme(mode, renderedMode), [mode, renderedMode])

  // Assign to whichever profile is live right now (read fresh so the callbacks
  // stay stable across profile switches).
  const liveProfile = () => normalizeProfileKey($activeGatewayProfile.get())

  const setTheme = useCallback((name: string) => {
    const next = normalizeSkin(name)
    recordFeatureUse('skins')
    setPreview(null)
    setThemeNameState(next)
    skinPref.assign(liveProfile(), next)
  }, [])

  const setMode = useCallback((next: ThemeMode) => {
    recordFeatureUse('skins')
    setPreview(null)
    setModeState(next)
    modePref.assign(liveProfile(), next)
  }, [])

  const previewTheme = useCallback((name: string, previewMode: 'light' | 'dark') => {
    setPreview(resolveTheme(name) ? { name, mode: previewMode } : null)
  }, [])

  const clearThemePreview = useCallback(() => setPreview(null), [])

  // Drain a backend-driven skin switch (Hermes authoring/activating a skin from a
  // prompt, or `/skin` on another surface). setTheme persists it per profile, so
  // the choice sticks like any manual pick.
  const pendingSkin = useStore($pendingSkinApply)

  useEffect(() => {
    if (pendingSkin) {
      setTheme(pendingSkin)
      $pendingSkinApply.set(null)
    }
  }, [pendingSkin, setTheme])

  // Same door for light/dark/system (set_theme from the agent).
  const pendingMode = useStore($pendingModeApply)

  useEffect(() => {
    if (pendingMode) {
      setMode(pendingMode)
      $pendingModeApply.set(null)
    }
  }, [pendingMode, setMode])

  // The light/dark toggle (Shift+X by default) is owned by the keybind runtime
  // (`appearance.toggleMode`) so it shows up in the hotkey map and is rebindable.

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme: paintedTheme,
      themeName: committedName,
      mode,
      resolvedMode,
      renderedMode,
      availableThemes,
      setTheme,
      setMode,
      previewTheme,
      clearThemePreview
    }),
    [
      paintedTheme,
      committedName,
      mode,
      resolvedMode,
      renderedMode,
      availableThemes,
      setTheme,
      setMode,
      previewTheme,
      clearThemePreview
    ]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export const useTheme = (): ThemeContextValue => useContext(ThemeContext)
