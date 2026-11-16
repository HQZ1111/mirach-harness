/** profile 短标签（hermes `lib/profile-short-label.ts`）。 */
export function profileShortLabel(profile: string, max = 2): string {
  const trimmed = (profile ?? '').trim()
  if (!trimmed) return '?'
  // 取首字母（多词取各词首字母）
  const words = trimmed.split(/\s+/).filter(Boolean)
  if (words.length > 1) {
    return words.slice(0, max).map((w) => w[0]!.toUpperCase()).join('')
  }
  return trimmed.slice(0, max).toUpperCase()
}
