/**
 * 左侧栏（docs/layout-design.md v6.0 §3）——单视图（会话列表）。
 * 顶带 = logo + **Mirach 文字**；点击 Mirach = 开合「机器人」弹出栏
 * （2026-11-07 完整移植 hermes 机器人页：原"会话/机器人双视图切换"改为
 * **左栏右侧弹出独立栏**，用户定稿口径。按钮态跟随面板在场——✕ 关闭 /
 * 存档恢复都反映到高亮）。
 */
import { useEffect } from 'react'

import { AssistantSessionsPane } from '@/components/panes/assistant-sessions-pane'
import { RailLogoLeading } from '@/components/layout/rail-logo-leading'
import { ProfileSwitcher } from '@/components/layout/profile-rail'
import {
  botsPanelStore,
  syncBotsPanelOpen,
  toggleBotsPanel,
  useBotsPanelOpen,
} from '@/components/panes/hub/bots-panel-actions'
import { useBotsFeatureDesired } from '@/plugins/bots-gate'

export function LeftRailPane() {
  const botsOpen = useBotsPanelOpen()
  const botsEnabled = useBotsFeatureDesired()
  // 挂载同步一次（fromJSON 恢复的面板不走 didAddPanel——布局事件在 boot
  // 路径不可依赖，读最终态最稳）；之后由 shell 的 didAdd/didRemove 事件驱动
  useEffect(() => {
    syncBotsPanelOpen()
  }, [])
  return (
    <div className="left-rail-pane" data-slot="left-rail-pane">
      <div className="left-rail-logo-row">
        <RailLogoLeading
          wordTitle={botsEnabled ? '点击打开 / 收起 机器人' : '机器人插件未启用'}
          onWordClick={botsEnabled ? toggleBotsPanel : undefined}
          wordActive={botsEnabled && botsOpen}
        />
      </div>
      <div className="left-rail-body">
        <AssistantSessionsPane />
      </div>
      {/* 配置档案切换器（2026-11-26 用户："档案栏改成头像+名字，点击头像
          弹窗切换档案，上下排列"）——替代原底部用户区（RailUserZone 已删）：
          当前环境头像+名字 + 齿轮；点头像/名字弹出垂直档案列表。 */}
      <ProfileSwitcher />
    </div>
  )
}
