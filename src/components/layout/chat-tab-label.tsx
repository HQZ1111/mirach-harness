/**
 * 对话栏列头双行块（用户定稿 2026-10-03；v8.0 dockview 版 2026-10-14 回迁）。
 * 上行 = 项目名（活动会话 cwd pathLeaf；新会话 = 最近选择的工作区，
 * 无 → 主页）；下行 = 会话显示名（pi name ?? 派生标题 ?? New Chat）。
 * **数据全部来自 sessionCatalog**（会话名/项目名单一真相源，runtime 是
 * 唯一写入者）——本组件只读投影，无本地状态。位置 = AssistantThreadPane
 * 的**容器子元素**（v8 布局定稿"工作区名=容器子元素"；原 ChatLabelOverlay
 * 宿主叠片随 M1 换壳丢失）——嵌在 85px 顶带区域内，与左栏 logo 同高带；
 * CSS 见 styles/panes.css 的 .chat-tab-label 规则集。
 */
import { useStore } from 'zustand';
import { ActivityIcon } from 'lucide-react';
import { workspaceGroupLabel } from '@/components/panes/session-manage/session-display';
import {
  sessionCatalog,
  sessionDisplayName,
  sessionProjectCwd,
} from '@/components/panes/session-manage/session-catalog';
import { VoiceLiveButton } from '@/components/assistant-ui/voice-live-panel';
import { statusPanelStore } from '@/components/assistant-ui/status-panel-store';
import { ChatHistoryButton } from '@/components/layout/chat-history-button';

/** 活动状态面板开合（2026-11-26 用户："对话区的语音通话图标左边再做个
 *  对话区活动面板的开关按钮"；随后："它不是折叠展开，点击连胶囊都没有，
 *  整个隐藏起来"——直接写 hidden，不再用 mini 胶囊当"关"）。 */
function StatusPanelToggle(): React.ReactElement | null {
  const override = useStore(statusPanelStore, (s) => s.override);
  const hidden = override === 'hidden';
  return (
    <button
      aria-label={hidden ? '显示活动面板' : '隐藏活动面板'}
      className={`pointer-events-auto flex size-8 shrink-0 items-center justify-center rounded-[4px] transition-colors ${
        hidden ? 'text-muted-foreground' : 'text-foreground'
      } hover:text-foreground`}
      data-slot="status-panel-toggle"
      onClick={() => statusPanelStore.getState().setOverride(hidden ? 'panel' : 'hidden')}
      title={hidden ? '显示活动面板' : '隐藏活动面板'}
      type="button"
    >
      <ActivityIcon className="size-[20px]" />
    </button>
  );
}

export function ChatTabLabel(): React.ReactElement | null {
  const entry = useStore(sessionCatalog, (s) =>
    s.activeId ? s.entries[s.activeId] : undefined,
  );
  const pendingCwd = useStore(sessionCatalog, (s) => s.pendingCwd);
  // 会话显示名统一走 sessionDisplayName（2026-11-25 用户："切换 bot 后会话名
  // 显示的是 bot 的名字，不是会话名了"）：pi 真名优先，但 **Bot Chat**
  // （机器人常驻会话的管道名）与**档案名污染**（旧 session.create 把 bot 名
  // 写成会话名）都降级为派生标题/「New Chat」——不再回落到机器人显示名。
  const title = sessionDisplayName(entry);
  const cwd = sessionProjectCwd(entry, pendingCwd);
  // 未选工作区（新会话 pendingCwd=null / 会话无 cwd）→ WORK SPACE 占位
  // （用户定稿 2026-10-03）。
  const workspace = cwd != null ? workspaceGroupLabel(cwd) : 'WORK SPACE';
  return (
    <div className="chat-tab-label" data-slot="chat-tab-label">
      {/* 行 1 = 工作区名（2026-11-22 用户："语音和聊天按钮往下移动，和会话
          名字的底部对齐，再放大一点"——动作组从工作区行挪到会话名行）。 */}
      <div className="chat-tab-label__row" data-slot="chat-tab-label-row">
        <span
          className="chat-tab-label__workspace"
          data-workspace={workspace}
          title={workspace}
        >
          {workspace}
        </span>
      </div>
      {/* 行 2 = 会话名 + 右侧动作组（底对齐）。title 悬停看全名：
          pointer-events 需在 span 上放行（锚层整体 none——见 flexlayout.css
          的 __session 规则） */}
      <div
        className="chat-tab-label__row chat-tab-label__row--session"
        data-slot="chat-tab-label-session-row"
      >
        <span className="chat-tab-label__session" data-session={title} title={title}>
          {title || '\u00a0'}
        </span>
        <div className="chat-tab-label__actions" data-slot="chat-tab-label-actions">
          <StatusPanelToggle />
          <VoiceLiveButton />
          <ChatHistoryButton />
        </div>
      </div>
    </div>
  );
}
