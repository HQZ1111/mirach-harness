import { useValue } from '@hermes/plugin-sdk'

import { useBotsStore, botPhotoImage } from '@/components/panes/hub/bots-store'
import { avatarColor, botAppearance, BotFace } from './avatar'
import { isChosenAvatarImage } from './avatar-image'
import { $botMeta } from './data'

/** A bot's face from its Bot Mode appearance (custom image/pet, else its shape + color).
 *  2026-11-26 用户："群聊里的自定义上传头像还是没生效"——plugin `$botMeta`
 *  可能是旧快照；宿主 botsStore 是 BotPreset 真源（imageKind/photo 判定
 *  与机器人页一致），优先用它。 */
export function RoomBotAvatar({ name, size = 24 }: { name: string; size?: number }) {
  const meta = useValue($botMeta) as Record<string, Parameters<typeof botAppearance>[1]>
  const hostBot = useBotsStore((s) => s.bots.find((bot) => bot.name === name) ?? null)
  const appearance = botAppearance(name, meta?.[name])
  const photo =
    botPhotoImage(hostBot) ??
    (isChosenAvatarImage(appearance.image, meta?.[name]?.imageKind) ? appearance.image ?? null : null)

  return <BotFace color={avatarColor(appearance.color, name)} image={photo} name={name} shape={appearance.shape} size={size} />
}
