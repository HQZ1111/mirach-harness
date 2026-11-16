/** profile 颜色（hermes `lib/profile-color.ts` 的宿主对偶）。
 *
 * 2026-11-16：实现从 `@/sdk/index` 内联回本文件。`@/sdk` 是 hermes 插件 SDK 的
 * shim，其 re-export 会拖入 `src/hermes-mirror/**` 里尚未接线的 hermes 内部
 * 组件（`@hermes/shared`、`@/components/pane-shell/*` 等未解析别名），一旦
 * 宿主主图 import 它，vite pre-transform 直接 500 → 整页白屏。
 * 颜色本身是纯函数，不依赖 SDK，内联后主图与插件移植解耦。
 */

/** 上游 `ColorSwatches`：bots 头像颜色选择器的色板。 */
export const ColorSwatches: readonly string[] = [
  '#e5484d',
  '#f76b15',
  '#f5d90a',
  '#30a46c',
  '#12a594',
  '#0091ff',
  '#6e56cf',
  '#e93d82',
  '#8d8d8d',
]

/** 上游 `PROFILE_SWATCHES`：profile 色板（与 ColorSwatches 同源）。 */
export const PROFILE_SWATCHES = ColorSwatches

/** 上游 `profileColor`：由名字确定性地取色。 */
export function profileColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  }
  return ColorSwatches[hash % ColorSwatches.length]!
}
