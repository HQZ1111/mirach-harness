/**
 * 对话标签双行块状态（用户定稿 2026-10-02 十轮）：工作区 + 会话名真实接线。
 * 数据面：runtime.tsx 在 currentThreadId 与 threads 变化时同步到本 store；
 * 消费方：flex-layout.tsx onRenderTab 拉伸头栏分支（region='main'）把
 * content 替换为 <ChatTabLabel />，左半留给原生 slot（实际上被覆盖），
 * 右半承担双行 chip，原始 ✕/home 钮走 renderValues.buttons 不动。
 * 跨层约束——runtime 可单向 import 本 store（layout 不 import assistant-ui）。
 */
import { createStore } from 'zustand/vanilla';

export interface ChatTabLabelState {
  /** 当前活跃 thread id；为 null 时 chip 不显示。 */
  threadId: string | null;
  /** 会话标题（rename 后的）。空 = pathJoin 时仍渲染 workspace 行。 */
  title: string;
  /** 工作区 cwd（pi 返回）；null = 没有工作区概念。 */
  cwd: string | null;
}

export const chatTabLabelStore = createStore<ChatTabLabelState>(() => ({
  threadId: null,
  title: '',
  cwd: null,
}));