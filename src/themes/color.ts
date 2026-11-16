/** 主题颜色工具（hermes `themes/color.ts` 的最小对偶）。 */
export function mixColor(a: string, b: string, t: number): string {
  const ratio = Math.max(0, Math.min(1, t))
  const parse = (hex: string): [number, number, number] => {
    const h = hex.replace('#', '')
    const n = Number.parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
  }
  const [r1, g1, b1] = parse(a)
  const [r2, g2, b2] = parse(b)
  const to = (x: number, y: number) => Math.round(x + (y - x) * ratio)
  return `#${[to(r1, r2), to(g1, g2), to(b1, b2)].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

/** 相对亮度（WCAG）。 */
export function luminance(hex: string): number {
  const h = hex.replace('#', '')
  const n = Number.parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
  const channel = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel((n >> 16) & 0xff) + 0.7152 * channel((n >> 8) & 0xff) + 0.0722 * channel(n & 0xff)
}

/** 在某底色上的可读文字色（上游 `readableInk`）。 */
export function readableInk(background: string): string {
  return luminance(background) > 0.5 ? '#000000' : '#ffffff'
}
