/**
 * 品牌 logo 是位图（蓝底 + 白脸），不能直接换 fill。用 hue-rotate +
 * saturate 把蓝底旋到主题色：白色区域不受色相旋转影响，脸部细节保留。
 * 主题色为空时以宿主品牌蓝 #006fff 为基准。
 */
const BASE_LOGO_COLOR = '#006fff'

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function hexToHsl(hex: string): { h: number; s: number; l: number } | null {
  const value = hex.trim().replace(/^#/, '')
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(value)) return null
  const normalized =
    value.length === 3
      ? value
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : value
  const r = Number.parseInt(normalized.slice(0, 2), 16) / 255
  const g = Number.parseInt(normalized.slice(2, 4), 16) / 255
  const b = Number.parseInt(normalized.slice(4, 6), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s, l }
}

export interface LogoFilterVars {
  hueRotate: string
  saturate: string
}

export function logoFilterFor(color: string): LogoFilterVars {
  const target = hexToHsl(color) ?? hexToHsl(BASE_LOGO_COLOR)
  const base = hexToHsl(BASE_LOGO_COLOR)
  if (!target || !base) return { hueRotate: '0deg', saturate: '1' }
  let delta = target.h - base.h
  if (delta > 180) delta -= 360
  if (delta < -180) delta += 360
  return {
    hueRotate: `${delta.toFixed(2)}deg`,
    // 基准色的饱和度是 100%，滤镜 saturate 是倍率。
    saturate: clamp(target.s / base.s, 0, 2).toFixed(3),
  }
}
