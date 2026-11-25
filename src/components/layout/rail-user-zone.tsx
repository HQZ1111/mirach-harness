/**
 * 左栏底部用户区（2026-10-19 用户："参考 zcode 下面的用户，一个头像，
 * 一个设置按钮"）。
 *
 * 2026-11-25 用户："左侧栏底部的用户改成当前生效的配置bot配置头像和名字"
 * ——头像/名字跟随**当前生效的配置**：
 *   1. 正在看的会话属于某个 bot（点机器人行/开 bot 聊天）= 那个 bot
 *      （`useSessionBot`，与对话区 AI 身份头像是同一判定）；`2026-11-25
 *      用户："左栏的左下角没有在切换机器人后变啊"——点击机器人行是导航
 *      （openRosterBot，不切引擎活动环境），底栏必须跟随**你看的 bot**，
 *      否则停在环境 bot 上，看起来就是"没变"。`
 *   2. 否则回落活动环境（active-profile）对应的花名册 bot；本体 =
 *      Mirach + 品牌 logo。
 *
 * 形态：单行贴底——左头像（圆形） + 中间名字（超长省略，悬停看全名） +
 * 右齿轮（打开既有设置浮层 `openSettingsOverlay`，与右键菜单/命令面板同一
 * 入口，不另造开关）。头像点击仍为占位（无账号体系）。
 *
 * 数据面：`botsStore`（花名册真源，runtime 启动时 load）+ `useActiveProfile`
 * （环境切换 bridge）+ `useSessionBot`（焦点会话归属）。profile 在花名册里
 * 找不到行时如实回落"本体"口径（Mirach + 品牌 logo）——不画空白，也不假装
 * 是别的 bot。
 */
import type { FC } from 'react'
import { SettingsIcon } from 'lucide-react'

import { Tooltip } from '@/components/motion/tooltip'
import { openSettingsOverlay } from '@/components/layout/app-context-menu'
import { useSessionBot } from '@/components/assistant-ui/message-avatars'
import {
  botDisplayName,
  DEFAULT_BOT_AVATAR,
  DEFAULT_BOT_NAME,
  useBotsStore,
} from '@/components/panes/hub/bots-store'
import { useActiveProfile } from '@/components/panes/session-manage/active-profile-bridge'

export const RailUserZone: FC = () => {
  const activeProfile = useActiveProfile()
  const bots = useBotsStore((s) => s.bots)
  const focusedBot = useSessionBot()
  const profileName = activeProfile ?? DEFAULT_BOT_NAME
  // 正在看的会话的归属 bot 优先（点机器人行/开 bot 聊天即命中）；否则活动
  // 环境的 bot；名册行缺失 → 本体口径（Mirach + 品牌 logo）。
  const bot = focusedBot ?? bots.find((b) => b.name === profileName)
  const label = bot ? botDisplayName(bot) : profileName === DEFAULT_BOT_NAME ? 'Mirach' : profileName
  const avatar = bot?.image?.trim() || DEFAULT_BOT_AVATAR

  return (
    <div className="rail-user-zone" data-slot="rail-user-zone">
      <button
        aria-label={label}
        className="rail-user-avatar pressable-sm"
        title={label}
        type="button"
      >
        <img alt="" aria-hidden className="rail-user-avatar-img" src={avatar} />
      </button>
      <span className="rail-user-name" title={label}>
        {label}
      </span>
      <Tooltip content="设置" side="top">
        <button
          aria-label="设置"
          className="rail-user-settings pressable-sm"
          onClick={() => openSettingsOverlay()}
          type="button"
        >
          <SettingsIcon aria-hidden className="size-[var(--size-icon-lg)]" />
        </button>
      </Tooltip>
    </div>
  )
}
