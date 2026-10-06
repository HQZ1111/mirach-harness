/**
 * 会话窗格（session-N 页签 / 分栏出的对话分栏，docs/layout-design.md §5）：
 * **自持投影**——按 config.threadId 渲染该会话，不再镜像全局活动会话
 * （v7.3：并排两个对话分栏各显各的会话，抄 hermes 的会话瓦片模型）。
 *
 * 两态：
 * - threadId === 目录 activeId（该会话就是主会话）→ **live**：复用全局
 *   runtime 的 AssistantThreadPane（与工作区一致——运行时只有一份流）；
 * - 否则 → **静态投影**：pi_get_session_messages(path) 读该会话文件
 *   （叶链回溯当前分支，Rust 侧还原），hydratePiMessages 映射，只读
 *   渲染（MarkdownText 正文 + 工具调用行）。发送/继续对话 = 「设为主
 *   会话」（switchSessionThreadBridge → activeId 翻转 → 本面板翻 live）。
 *   hermes 会话瓦片各有 composer；本项目运行时单流（§11 已记录升级位），
 *   静态面板 v1 只读。
 *
 * 刷新 = 手动钮（水合按需；运行只发生在主会话，静态会话内容不自行变化）。
 * 错误可见（规矩 12）：文件读取失败原样上屏。
 */
import { invoke } from '@tauri-apps/api/core'
import { FC, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { hydratePiMessages } from '@/components/assistant-ui/pi-hydrate'
import { AssistantThreadPane } from '@/components/panes/assistant-thread-pane'
import { switchSessionThreadBridge } from '@/components/panes/session-manage/session-tab-bridge'
import { sessionDisplayName, useSessionManage } from '@/components/panes/session-manage/session-catalog'
import type { TurnMessage } from '@/components/assistant-ui/turn-actor'

type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; messages: TurnMessage[] }

/** 静态投影的简化 markdown 渲染（react-markdown 直用——MarkdownText
 *  挂在运行时消息上下文上，只读面板无上下文；主会话仍是全管线）。 */
const StaticMarkdown: FC<{ text: string }> = ({ text }) => (
  <div className="aui-md">
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => (
          <pre className="my-3 overflow-x-auto rounded-md bg-muted/60 p-3 text-[0.85em] leading-relaxed">{children}</pre>
        ),
        code: ({ className, children }) => (
          <code
            className={
              className ??
              'rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em]'
            }
          >
            {children}
          </code>
        ),
      }}
    >
      {text}
    </ReactMarkdown>
  </div>
)

const ToolRow: FC<{ name: string; done: boolean; errored: boolean }> = ({ name, done, errored }) => (
  <div className="my-1 flex w-fit items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
    <span aria-hidden>{errored ? '✗' : done ? '✓' : '…'}</span>
    <span>{name || 'tool'}</span>
  </div>
)

const StaticTranscript: FC<{ messages: TurnMessage[] }> = ({ messages }) => {
  if (messages.length === 0) {
    return <div className="flex h-full items-center justify-center text-sm text-muted-foreground">（空会话）</div>
  }
  return (
    <div className="flex flex-col gap-4 overflow-y-auto px-6 py-5" data-slot="session-static-transcript">
      {messages.map((m) => {
        const parts = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content
        if (m.role === 'user') {
          return (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-(--composer-radius) bg-muted px-4 py-2 text-foreground">
                {parts.map((p, i) =>
                  p.type === 'text' ? (
                    <span key={i} className="whitespace-pre-wrap">
                      {p.text}
                    </span>
                  ) : p.type === 'image' ? (
                    <img key={i} src={p.image} alt="" className="max-h-60 rounded-md" />
                  ) : null,
                )}
              </div>
            </div>
          )
        }
        return (
          <div key={m.id} className="flex flex-col gap-1">
            {parts.map((p, i) =>
              p.type === 'text' ? (
                <div key={i} className="text-foreground">
                  <StaticMarkdown text={p.text} />
                </div>
              ) : p.type === 'tool-call' ? (
                <ToolRow key={i} name={p.toolName} done={p.result !== undefined} errored={p.isError === true} />
              ) : p.type === 'image' ? (
                <img key={i} src={p.image} alt="" className="max-h-60 rounded-md" />
              ) : null,
            )}
          </div>
        )
      })}
    </div>
  )
}

export function SessionThreadPane({ threadId, tabName }: { threadId: string; tabName: string }) {
  const activeId = useSessionManage((s) => s.activeId)
  const path = useSessionManage((s) => s.entries[threadId]?.path)
  const title = useSessionManage((s) => sessionDisplayName(s.entries[threadId]))
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [rev, setRev] = useState(0)
  const live = threadId === activeId

  useEffect(() => {
    if (live) return
    let dead = false
    setLoad({ kind: 'loading' })
    if (!path) {
      setLoad({ kind: 'error', message: '会话文件路径不在场（pi 列表未含该会话）' })
      return
    }
    invoke<Record<string, unknown>[]>('pi_get_session_messages', { path })
      .then((history) => {
        if (!dead) setLoad({ kind: 'ok', messages: hydratePiMessages(history ?? []) })
      })
      .catch((e) => {
        if (!dead) setLoad({ kind: 'error', message: String(e) })
      })
    return () => {
      dead = true
    }
  }, [live, path, rev])

  if (live) return <AssistantThreadPane />

  return (
    <div className="assistant-thread-pane flex h-full flex-col" data-slot="session-thread-pane">
      <div className="flex items-center gap-2 border-b border-border/40 px-4 py-1.5 text-xs text-muted-foreground">
        <span className="truncate" title={tabName}>
          {title || tabName || '会话'}（只读投影）
        </span>
        <span className="flex-1" />
        <button
          className="rounded-md border border-border/50 px-2 py-0.5 hover:bg-(--hover-wash)"
          onClick={() => setRev((r) => r + 1)}
        >
          刷新
        </button>
        <button
          className="rounded-md border border-border/50 px-2 py-0.5 hover:bg-(--hover-wash)"
          onClick={() => switchSessionThreadBridge(threadId)}
        >
          设为主会话
        </button>
      </div>
      {load.kind === 'loading' ? (
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">读取会话历史…</div>
      ) : load.kind === 'error' ? (
        <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm">
          <span className="text-destructive">会话历史读取失败</span>
          <span className="text-muted-foreground">{load.message}</span>
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <StaticTranscript messages={load.messages} />
        </div>
      )}
    </div>
  )
}
