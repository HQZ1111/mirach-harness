/**
 * 对话标签双行块（用户定稿 2026-10-02 十轮）。
 * 上行 = 工作区（cwd pathLeaf，hermes 同款路径截取），无 cwd → 主页。
 * 下行 = 会话标题（rename 后名）。
 * 位置：tab 按钮右半部分（left:50% / max-width 50%），原 tab 默认文本被
 * content 替换让位；trailing buttons（✕/home）继续 trailing 占位不重叠
 * 文本（pointer-events:none，文本只读不挡钮）。CSS 见 styles/flexlayout.css
 * 里的 .chat-tab-label 规则集（绝对定位、字号、颜色皆引用 tokens.css）。
 */
import { useStore } from 'zustand';
import { workspaceGroupLabel } from '@/components/panes/session-manage/session-display';
import { chatTabLabelStore } from './chat-tab-label-store';

export function ChatTabLabel(): React.ReactElement | null {
  const threadId = useStore(chatTabLabelStore, (s) => s.threadId);
  const title = useStore(chatTabLabelStore, (s) => s.title);
  const cwd = useStore(chatTabLabelStore, (s) => s.cwd);
  if (threadId == null) return null;
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