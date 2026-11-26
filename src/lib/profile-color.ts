/**
 * 配置档案颜色（hermes `lib/profile-color.ts` 逐字移植，2026-11-26 用户：
 * "配置档案栏怎么和hermes不一样"——旧版是自造的 9 色 hex 板 + 取模索引，
 * 与 hermes 的确定性色相/覆盖色/默认中性三件套不同）。
 *
 * 上游语义：
 * - 具名档案有确定性色相（名字哈希 → hsl(… 68% 58%)），换设备也一致；
 * - 默认（本体）档案没有颜色（null = 中性，不着色）；
 * - 用户挑的颜色作为 override 优先（resolveProfileColor）；
 * - PROFILE_SWATCHES = 12 枚同饱和/明度均匀色相（档案栏选择器 + 头像
 *   选择器共用，hermes avatar-picker 同源）。
 */

/** 具名档案色相的饱和度（hermes 原值）。 */
const PROFILE_TAG_SATURATION = 68
/** 具名档案色相的明度（hermes 原值）。 */
const PROFILE_TAG_LIGHTNESS = 58

function hashString(value: string): number {
  let hash = 0

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }

  return hash
}

/** 具名档案的确定性颜色；默认/空 = null（中性，不标色）。 */
export function profileColor(name: null | string | undefined): null | string {
  const key = (name ?? '').trim()

  if (!key || key === 'default') {
    return null
  }

  const hue = hashString(key) % 360

  return `hsl(${hue} ${PROFILE_TAG_SATURATION}% ${PROFILE_TAG_LIGHTNESS}%)`
}

/** 档案的有效颜色：用户覆盖优先，否则确定性色相；默认档案恒 null。 */
export function resolveProfileColor(
  name: null | string | undefined,
  overrides: Record<string, string>,
): null | string {
  const key = (name ?? '').trim()

  if (!key || key === 'default') {
    return null
  }

  return overrides[key] ?? profileColor(key)
}

/** 选择器的 12 枚预设色（hermes PROFILE_SWATCHES 原样）。 */
export const PROFILE_SWATCHES: readonly string[] = Array.from(
  { length: 12 },
  (_, index) => `hsl(${index * 30} ${PROFILE_TAG_SATURATION}% ${PROFILE_TAG_LIGHTNESS}%)`,
)

/** 从档案色派生出的浅底（色块背景，hermes profileColorSoft 原样）。 */
export function profileColorSoft(color: string, percent = 16): string {
  return `color-mix(in srgb, ${color} ${percent}%, transparent)`
}
