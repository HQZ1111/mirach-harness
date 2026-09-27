/**
 * assistant-ui 运行时接入（L1，docs 待办 3）：本地 mock 模型适配器——
 * 逐段流式回显，无后端即可驱动完整对话 UI（发消息→流式→渲染）。
 * pi 接入（L4）后把 mockModelAdapter 换成真实模型适配器即可，UI 不动。
 * aui 预置样式经 styles/index.css 引入（自带类名体系，不走 Tailwind 构建）。
 */
import { AssistantRuntimeProvider, useLocalRuntime, type ChatModelAdapter } from '@assistant-ui/react'

/** 本地 mock 模型：回显用户最后一条消息 + 固定文案，分两段流式输出 */
const mockModelAdapter: ChatModelAdapter = {
  async *run({ messages }) {
    const last = messages[messages.length - 1]
    const question = last?.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('')
      .trim()
    const parts = [
      `收到：${question || '（空消息）'}`,
      '\n\n这是本地 mock 流式回复——pi 接入（L4）后由真实模型驱动，本窗格 UI 不变。',
    ]
    let text = ''
    for (const part of parts) {
      await new Promise((resolve) => setTimeout(resolve, 300))
      text += part
      yield { content: [{ type: 'text' as const, text }] }
    }
  },
}

export function AssistantRuntime({ children }: { children: React.ReactNode }) {
  const runtime = useLocalRuntime(mockModelAdapter)
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
