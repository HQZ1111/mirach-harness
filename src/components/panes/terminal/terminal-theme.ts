/**
 * xterm 主题——从 CSS 令牌（--term-*，tokens.css）读取终端配色。
 * ZCode terminalTheme.ts 的移植（去掉 profile theme 继承——本工程无
 * 终端 profile 系统）：xterm 的 `css.toColor` 不认 `var()`/现代 rgb 语法，
 * 先用隐藏元素让浏览器解析，再经 canvas 规范化为老式 rgba 字符串。
 */

import type { ITheme } from '@xterm/xterm'

function readTerminalColor(style: CSSStyleDeclaration, name: string, fallback: string) {
  return style.getPropertyValue(name).trim() || fallback
}

const colorResolverEl: HTMLSpanElement | null =
  typeof document === 'undefined' ? null : document.createElement('span')
const colorNormalizeCtx: CanvasRenderingContext2D | null = (() => {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx) ctx.globalCompositeOperation = 'copy'
  return ctx
})()

function normalizeCssColor(raw: string, fallback: string): string {
  if (!raw || !colorResolverEl || !colorNormalizeCtx || !document.body) {
    return raw || fallback
  }
  try {
    document.body.appendChild(colorResolverEl)
    colorResolverEl.style.color = ''
    colorResolverEl.style.color = raw
    const resolved = getComputedStyle(colorResolverEl).color
    colorNormalizeCtx.fillStyle = '#000'
    colorNormalizeCtx.fillStyle = resolved
    colorNormalizeCtx.fillRect(0, 0, 1, 1)
    const [r = 0, g = 0, b = 0, a = 255] = colorNormalizeCtx.getImageData(0, 0, 1, 1).data
    return `rgba(${r}, ${g}, ${b}, ${+(a / 255).toFixed(3)})`
  } catch {
    return fallback
  } finally {
    colorResolverEl.remove()
  }
}

/** 令牌名 → xterm 主题键（fallback 与 tokens.css 的 --term-* 同值；
 *  2026-11-18 起 = ZCode 默认浅色主题配色，bg 用宿主面板色 #ffffff） */
const TERMINAL_THEME_TOKENS = {
  background: ['--term-bg', '#ffffff'],
  foreground: ['--term-fg', '#0a0a0a'],
  cursor: ['--term-cursor', '#0a0a0a'],
  cursorAccent: ['--term-cursor-accent', '#ffffff'],
  selectionBackground: ['--term-selection', 'rgba(0, 166, 244, 0.32)'],
  selectionInactiveBackground: ['--term-selection-inactive', 'rgba(0, 166, 244, 0.22)'],
  black: ['--term-black', '#404040'],
  red: ['--term-red', '#fb2c36'],
  green: ['--term-green', '#00c950'],
  yellow: ['--term-yellow', '#f0b100'],
  blue: ['--term-blue', '#00a6f4'],
  magenta: ['--term-magenta', '#e12afb'],
  cyan: ['--term-cyan', '#00b8db'],
  white: ['--term-white', '#737373'],
  brightBlack: ['--term-bright-black', '#737373'],
  brightRed: ['--term-bright-red', '#fb2c36'],
  brightGreen: ['--term-bright-green', '#00c950'],
  brightYellow: ['--term-bright-yellow', '#f0b100'],
  brightBlue: ['--term-bright-blue', '#00a6f4'],
  brightMagenta: ['--term-bright-magenta', '#e12afb'],
  brightCyan: ['--term-bright-cyan', '#00b8db'],
  brightWhite: ['--term-bright-white', '#0a0a0a'],
} as const satisfies Partial<Record<keyof ITheme, readonly [string, string]>>

/** 从 CSS 变量读取终端主题色（每次建 xterm 实例时取一次） */
export function getTerminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement)
  return Object.fromEntries(
    Object.entries(TERMINAL_THEME_TOKENS).map(([key, [tokenName, fallback]]) => [
      key,
      normalizeCssColor(readTerminalColor(style, tokenName, fallback), fallback),
    ]),
  ) as ITheme
}

/** 终端字体（--term-font-family/--term-font-size 令牌；取不到值用
 *  ZCode DEFAULT_TERMINAL_FONT_FAMILY 同款 fallback） */
export function getTerminalFont(): { fontFamily: string; fontSize: number } {
  const style = getComputedStyle(document.documentElement)
  const fontFamily =
    style.getPropertyValue('--term-font-family').trim() ||
    "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Monaco, Consolas, 'Cascadia Mono', 'JetBrains Mono', 'MesloLGS NF', 'Hack Nerd Font', monospace"
  const fontSize = Number.parseFloat(style.getPropertyValue('--term-font-size'))
  return { fontFamily, fontSize: Number.isFinite(fontSize) ? fontSize : 13 }
}
