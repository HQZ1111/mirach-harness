/** `@/lib/text` 的宿主对偶：转发 `hermes-shim/lib/text`（同一份上游实现）。 */
export * from '@/hermes-shim/lib/text'

/**
 * 紧凑数字（上游 `lib/text.ts` 的 `compactNumber`）：1234 → 1.2k。
 *
 * 用于 UI 里显示计数（成员数、消息数、字节数）。
 */
export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const abs = Math.abs(value)
  const trim = (n: number, unit: string): string => `${n.toFixed(1).replace(/\.0$/, '')}${unit}`
  if (abs < 1000) return String(Math.round(value))
  if (abs < 1_000_000) return trim(value / 1000, 'k')
  if (abs < 1_000_000_000) return trim(value / 1_000_000, 'M')
  return trim(value / 1_000_000_000, 'B')
}