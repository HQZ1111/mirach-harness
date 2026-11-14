/**
 * 左栏底部用户区（2026-10-19 用户："参考 zcode 下面的用户，一个头像，
 * 一个设置按钮"）。
 *
 * 形态：单行贴底——左头像 + 右齿轮（各自圆形按钮），与左栏内容线对齐
 * （--rail-gutter / 右侧同值）。头像点击暂为占位（无账号体系），设置钮
 * 打开既有设置浮层（`openSettingsOverlay`，与右键菜单/命令面板同一入口，
 * 不另造开关）。
 *
 * 为什么不做通知卡：通知数据源（pi 侧事件 → UI 卡片）尚未定义，先留位
 * 不造假数据（AGENTS「禁止兜底」）。结构上这里已是 flex 列，后续在头像行
 * **上方**加卡片即可，不影响本行布局。
 */
import type { FC } from 'react'
import { SettingsIcon } from 'lucide-react'

import { Tooltip } from '@/components/motion/tooltip'
import { openSettingsOverlay } from '@/components/layout/app-context-menu'

/** 头像占位字形（无账号体系，用品牌色圆 + 首字母 M；用户接入账号后替换）。 */
const AvatarMark: FC = () => (
  <span aria-hidden className="rail-user-avatar-mark">
    M
  </span>
)

export const RailUserZone: FC = () => (
  <div className="rail-user-zone" data-slot="rail-user-zone">
    <button
      aria-label="账户"
      className="rail-user-avatar pressable-sm"
      title="账户"
      type="button"
    >
      <AvatarMark />
    </button>
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
