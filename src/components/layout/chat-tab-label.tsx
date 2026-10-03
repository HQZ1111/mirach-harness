/**
 * 对话标签双行块（用户定稿 2026-10-03，廿一轮单一真相源化）。
 * 上行 = 项目名（活动会话 cwd pathLeaf；新会话 = 最近选择的工作区，
 * 无 → 主页）；下行 = 会话显示名（pi name ?? 派生标题 ?? New Chat）。
 * **数据全部来自 sessionCatalog**（会话名/项目名单一真相源，runtime 是
 * 唯一写入者）——本组件只读投影，无本地状态。位置 = 宿主层叠片
 * ChatLabelOverlay（chrome-overlays.tsx，相对 workspace tabset 顶带）；
 * CSS 见 styles/flexlayout.css 的 .chat-tab-label 规则集。
 */
import { useStore } from 'zustand';
import { workspaceGroupLabel } from '@/components/panes/session-manage/session-display';
import {
  sessionCatalog,
  sessionDisplayName,
  sessionProjectCwd,
} from '@/components/panes/session-manage/session-catalog';

export function ChatTabLabel(): React.ReactElement | null {
  const entry = useStore(sessionCatalog, (s) =>
    s.activeId ? s.entries[s.activeId] : undefined,
  );
  const pendingCwd = useStore(sessionCatalog, (s) => s.pendingCwd);
  const title = sessionDisplayName(entry);
  const cwd = sessionProjectCwd(entry, pendingCwd);
  const workspace = cwd != null ? workspaceGroupLabel(cwd) : '';
  return (
    <div className="chat-tab-label" data-slot="chat-tab-label">
      <span className="chat-tab-label__workspace" data-workspace={workspace}>
        {workspace}
      </span>
      <span className="chat-tab-label__session" data-session={title}>
        {title || '\u00a0'}
      </span>
    </div>
  );
}
