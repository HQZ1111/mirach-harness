/**
 * 左侧栏（v5.0 · docs/layout-design.md §1）——会话列表/机器人花名册双视图，
 * 无页签条。顶带 = logo + Mirach 文字（可点击切换视图）；顶带下是活动视图。
 * v5.0 以前 sessions/bots 是两个独立页签；v5.0 合为一个窗格内切换。
 */
import { useState } from 'react'

import { AssistantSessionsPane } from '@/components/panes/assistant-sessions-pane'
import { BotsPane } from '@/components/panes/bots-pane'
import { RailLogoLeading } from '@/components/layout/rail-logo-leading'

type LeftRailView = 'sessions' | 'bots'

export function LeftRailPane() {
  const [view, setView] = useState<LeftRailView>('sessions')
  return (
    <div className="left-rail-pane" data-slot="left-rail-pane">
      <div className="left-rail-logo-row">
        <RailLogoLeading />
        <button
          className={`left-rail-switch${view === 'bots' ? ' left-rail-switch-alt' : ''}`}
          onClick={() => setView((v) => (v === 'sessions' ? 'bots' : 'sessions'))}
          type="button"
        >
          {view === 'sessions' ? '机器人' : '会话列表'}
        </button>
      </div>
      <div className="left-rail-body">
        {view === 'sessions' ? <AssistantSessionsPane /> : <BotsPane />}
      </div>
    </div>
  )
}
