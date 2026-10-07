/**
 * 左侧栏（docs/layout-design.md v6.0 §3）——会话列表/机器人花名册双视图，
 * 无页签条。顶带 = logo + **Mirach 文字**；点击 Mirach 文字切换两视图
 * （文字 hover 变色/按压效果，与页签"文字即按钮"范式同款）。
 * v5.0 以前 sessions/bots 是两个独立页签；v5.0 起合为一个窗格内切换。
 * 2026-10-06：**视图指示字删除**（logo 行右下的「会话/机器人」小字）——
 * Mirach 文字是唯一切换钮，指示字冗余（用户截图定稿）。
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
        <RailLogoLeading
          wordTitle="点击切换 会话 / 机器人"
          onWordClick={() => setView((v) => (v === 'sessions' ? 'bots' : 'sessions'))}
        />
      </div>
      <div className="left-rail-body">
        {view === 'sessions' ? <AssistantSessionsPane /> : <BotsPane />}
      </div>
    </div>
  )
}
