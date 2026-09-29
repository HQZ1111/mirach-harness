/**
 * assistant-ui 运行时接入（L1，docs 待办 3）：本地 mock 模型适配器——
 * 模拟一次真实运行的全部阶段：思考片段流式（触发官方 Reasoning 的
 * 思考前/思考中/折叠态）→ 工具调用（触发官方 ToolGroup 折叠/运行态）→
 * 最终文本。pi 接入（L4）后把 mockModelAdapter 换成真实模型适配器即可，
 * UI 不动。模型/思考等级经 ModelSelector 注册进 ModelContext（官方
 * ModelContext 系统），运行器从这里读——mock 只回显。
 */
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  type ChatModelAdapter,
  type ChatModelRunResult,
} from '@assistant-ui/react'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 本地 mock 模型：完整阶段模拟（reasoning 流式 → tool-call → text） */
const mockModelAdapter: ChatModelAdapter = {
  async *run({ messages }): AsyncGenerator<ChatModelRunResult, void, unknown> {
    const last = messages[messages.length - 1]
    const question = last?.content
      .map((c) => (c.type === 'text' ? c.text : ''))
      .join('')
      .trim()

    // ── 阶段 1：思考（reasoning 片段流式——官方 Reasoning 元素的
    //    streaming 态：触发器显示"思考中"，完成后折叠）──
    let reasoning = ''
    const reasoningSteps = [
      `分析请求："${question || '（空消息）'}"`,
      '拆解为步骤：理解意图 → 查询（模拟工具） → 汇总回答。',
      '准备调用模拟工具获取数据。',
    ]
    for (const step of reasoningSteps) {
      await sleep(420)
      reasoning += (reasoning ? '\n\n' : '') + step
      yield {
        content: [{ type: 'reasoning' as const, text: reasoning, status: { type: 'running' as const } }],
      }
    }

    // ── 阶段 2：工具调用（官方 ToolGroup 的运行态→完成折叠；
    //    适配器结果里 tool-call 不带 status——运行态由有无 result 推导）──
    await sleep(350)
    yield {
      content: [
        { type: 'reasoning' as const, text: reasoning, status: { type: 'complete' as const } },
        {
          type: 'tool-call' as const,
          toolCallId: 'mock-call-1',
          toolName: 'mock_search',
          args: { query: question || '空查询' },
          argsText: JSON.stringify({ query: question || '空查询' }),
        },
      ],
    }
    await sleep(700)
    const answer = `已处理："${question || '（空消息）'}"。\n\n这是本地 mock 流式回复——**思考片段**与**工具调用**均为模拟数据，用于驱动官方 Reasoning / ToolGroup 元素的全部状态；pi 接入（L4）后由真实模型驱动，本窗格 UI 不变。`
    yield {
      content: [
        { type: 'reasoning' as const, text: reasoning, status: { type: 'complete' as const } },
        {
          type: 'tool-call' as const,
          toolCallId: 'mock-call-1',
          toolName: 'mock_search',
          args: { query: question || '空查询' },
          argsText: JSON.stringify({ query: question || '空查询' }),
          result: 'mock：查询完成（模拟结果）',
        },
      ],
    }

    // ── 阶段 3：最终文本（流式）──
    let text = ''
    for (const part of answer.split('\n\n')) {
      await sleep(300)
      text += (text ? '\n\n' : '') + part
      yield {
        content: [
          { type: 'reasoning' as const, text: reasoning, status: { type: 'complete' as const } },
          {
            type: 'tool-call' as const,
            toolCallId: 'mock-call-1',
            toolName: 'mock_search',
            args: { query: question || '空查询' },
          argsText: JSON.stringify({ query: question || '空查询' }),
            result: 'mock：查询完成（模拟结果）',
          },
          { type: 'text' as const, text },
        ],
      }
    }
  },
}

export function AssistantRuntime({ children }: { children: React.ReactNode }) {
  const runtime = useLocalRuntime(mockModelAdapter)
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
