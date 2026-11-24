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
import { workspaceGroupLabel } from '@/components/panes/session-manage/session-display';
import {
  sessionCatalog,
  sessionDisplayName,
  sessionProjectCwd,
} from '@/components/panes/session-manage/session-catalog';
import { botDisplayName, botsStore } from '@/components/panes/hub/bots-store';
import { VoiceLiveButton } from '@/components/assistant-ui/voice-live-panel';
import { ChatHistoryButton } from '@/components/layout/chat-history-button';

export function ChatTabLabel(): React.ReactElement | null {
  const entry = useStore(sessionCatalog, (s) =>
    s.activeId ? s.entries[s.activeId] : undefined,
  );
  const pendingCwd = useStore(sessionCatalog, (s) => s.pendingCwd);
  // bot canonical chat 的**真名**固定 "Bot Chat"（引擎/registry 身份），
  // 但对话区下行要显示"会话名"：手动重命名过就显示自定义名；否则与普通
  // 会话同款优先派生标题（首条用户消息），尚未说过话时显示机器人名。
  // 2026-11-23 用户："下面是会话名，现在会话名变成 bot chat 了"。
  const botChat = entry
    ? botsStore.getState().bots.find((b) => b.chatSessionId === entry.id)
    : undefined;
  const customName =
    entry?.piName && entry.piName !== 'Bot Chat' ? entry.piName : undefined;
  const title = botChat
    ? customName ?? entry?.derivedTitle ?? botDisplayName(botChat)
    : sessionDisplayName(entry);
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
          <VoiceLiveButton />
          <ChatHistoryButton />
        </div>
      </div>
    </div>
  );
}
