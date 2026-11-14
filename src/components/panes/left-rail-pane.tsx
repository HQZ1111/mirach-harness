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
import { RailUserZone } from '@/components/layout/rail-user-zone'
import {
  botsPanelStore,
  syncBotsPanelOpen,
  toggleBotsPanel,
  useBotsPanelOpen,
} from '@/components/panes/hub/bots-panel-actions'

export function LeftRailPane() {
  const botsOpen = useBotsPanelOpen()
  // 挂载同步一次（fromJSON 恢复的面板不走 didAddPanel——布局事件在 boot
  // 路径不可依赖，读最终态最稳）；之后由 shell 的 didAdd/didRemove 事件驱动
  useEffect(() => {
    syncBotsPanelOpen()
  }, [])
  return (
    <div className="left-rail-pane" data-slot="left-rail-pane">
      <div className="left-rail-logo-row">
        <RailLogoLeading
          wordTitle="点击打开 / 收起 机器人"
          onWordClick={toggleBotsPanel}
          wordActive={botsOpen}
        />
      </div>
      <div className="left-rail-body">
        <AssistantSessionsPane />
      </div>
      {/* 底部用户区（2026-10-19，用户："参考 zcode 下面的用户"）：
          头像 + 设置钮，贴左栏底。通知卡留位：将来在 .rail-user-zone
          **上方**加，本行结构不用改。 */}
      <RailUserZone />
    </div>
  )
}
