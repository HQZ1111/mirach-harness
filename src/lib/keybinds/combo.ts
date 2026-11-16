/**
 * 键位组合（hermes `lib/keybinds/combo.ts` 的宿主对偶）。
 *
 * 上游除了把事件转成组合，还导出 `comboTokens`（组合 → 可渲染的键帽数组，
 * `kbd.tsx` 依赖它）。这里两者都实现。
 */

export interface KeyCombo {
  key: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  alt?: boolean
}

/** 从键盘事件取组合。 */
export function comboFromEvent(event: KeyboardEvent): KeyCombo {
  return {
    key: event.key,
    ctrl: event.ctrlKey || undefined,
    meta: event.metaKey || undefined,
    shift: event.shiftKey || undefined,
    alt: event.altKey || undefined,
  }
}

/**
 * 组合 → 键帽 token 数组（上游 `comboTokens`）。
 *
 * 例：`{ key: 'k', meta: true }` → `['⌘', 'K']`。
 * macOS 用符号，其他平台用文字。
 */
export function comboTokens(combo: KeyCombo, platform?: string): string[] {
  const isMac = (platform ?? (typeof navigator !== 'undefined' ? navigator.platform : '') ?? '')
    .toLowerCase()
    .includes('mac')
  const tokens: string[] = []
  if (combo.ctrl) tokens.push(isMac ? '⌃' : 'Ctrl')
  if (combo.meta) tokens.push(isMac ? '⌘' : 'Win')
  if (combo.alt) tokens.push(isMac ? '⌥' : 'Alt')
  if (combo.shift) tokens.push(isMac ? '⇧' : 'Shift')
  tokens.push(combo.key.length === 1 ? combo.key.toUpperCase() : combo.key)
  return tokens
}

/** 组合 → 可读文案。 */
export function comboLabel(combo: KeyCombo, platform?: string): string {
  return comboTokens(combo, platform).join(isMacPlatform(platform) ? '' : '+')
}

function isMacPlatform(platform?: string): boolean {
  const p = platform ?? (typeof navigator !== 'undefined' ? navigator.platform : '') ?? ''
  return p.toLowerCase().includes('mac')
}