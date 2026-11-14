/**
 * 机器人页类型——hermes `plugins/hermes-bots/types.ts` 的宿主对偶。
 *
 * **BotMeta 逐字段照抄**（2026-11-07）：宿主 bot = 本地预设（bots-store 头
 * 注释的裁定），hermes 的 BotMeta 走 profile.yaml 的 `ui_meta['hermes-bots']`
 * ——两个存储面字段同名同义，移植时 UI 层零翻译。宿主用不到的网关字段
 * （connectionId / route / worker_session…）在 RosterRow 上，这里不收——
 * 宿主没有多网关面。
 */

/** 头像形状（avatar.tsx 的 AVATAR_SHAPES 词表 + blobatar 扩展形状）。 */
export type AvatarShape =
  | 'circle'
  | 'cloud'
  | 'drop'
  | 'hexagon'
  | 'pill'
  | 'squircle'
  | 'triangle'

/** 表情（face clock 的三态）。 */
export type FaceMood = 'idle' | 'think' | 'work'

export interface AvatarAppearance {
  /** `null` when nothing is picked — the name's deterministic hue stands in. */
  color: null | string
  image: null | string
  /** Free-form: a bare shape, `sigil-<n>`, or `blobatar:<seed>:<kind>`. */
  shape: string
}

/** hermes `BotMeta`（ui_meta['hermes-bots']）逐字段照抄。宿主存的字段子集
 *  见 bots-store 的 BotPreset；其余可选字段保留原文形状（可选 = 不用也不
 *  违例），screen 相关随 Screen 面一起不移植。 */
export interface BotMeta {
  /** Which user-made section this bot is filed under (`user-sections.ts`).
   *  Membership lives on the BOT, not as a member list on the section. */
  sectionId?: null | string
  /** The section's display name, written beside `sectionId` on every filing. */
  sectionName?: null | string
  color?: string
  /** Set when the user has customized the avatar, so defaults stop applying. */
  custom?: boolean
  description?: string
  hidden?: boolean
  /** Data URL. */
  image?: null | string
  imageKind?: 'photo' | 'shape'
  pinned?: boolean
  shape?: string
  title?: string
  /** Creation timestamp in ms. Deliberately not copied when duplicating a bot. */
  created?: number
}
