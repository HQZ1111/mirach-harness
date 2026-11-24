/**
 * 聊天记录钮（对话区标题栏右上角，语音通话钮右侧；2026-11-15 用户定稿
 * "右边再加个聊天记录的图标，和微信一样"）。
 *
 * 数据 = assistant-ui 线程消息投影（`useAuiState(s => s.thread.messages)`，
 * 与对话区同一真相，不另拉 IPC）：用户/助手消息按时间列出摘要，点行无
 * 副作用（只读历史）。空线程 = 面板显示"暂无消息"。
 */
import { HistoryIcon } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type FC } from 'react'
import { createPortal } from 'react-dom'
import { useAuiState } from '@assistant-ui/react'

interface HistoryRow {
  id: string
  role: 'user' | 'assistant'
  text: string
  at: Date | null
}

/** ThreadMessage 的内容可能是串或部件数组；只取文本部件拼摘要。 */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .map((p) => {
      if (typeof p !== 'object' || p === null) return ''
      const part = p as { type?: unknown; text?: unknown }
      return part.type === 'text' && typeof part.text === 'string' ? part.text : ''
    })
    .join(' ')
    .trim()
}

const TIME_FMT = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
})

export const ChatHistoryButton: FC = () => {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)
  const raw = useAuiState((s) => s.thread.messages)

  const rows = useMemo<HistoryRow[]>(() => {
    const out: HistoryRow[] = []
    for (const m of raw) {
      if (m.role !== 'user' && m.role !== 'assistant') continue
      const text = textOf((m as { content?: unknown }).content)
      if (!text) continue
      const createdAt = (m as { createdAt?: unknown }).createdAt
      out.push({
        id: m.id,
        role: m.role,
        text,
        at: createdAt instanceof Date ? createdAt : null,
      })
    }
    return out
  }, [raw])

  // 浮层必须 **portal 到 body**：列头 `.chat-tab-label` 有 overflow:hidden
  // （75px 顶带的裁切语义），挂在里面会被裁成只剩标题行（2026-11-15 实测）。
  // 打开时按按钮 rect 固定定位（fixed），滚动/缩放关闭（简单可靠）。
  const openAt = () => {
    const el = rootRef.current?.querySelector('[data-slot="chat-history-button"]')
    const r = el?.getBoundingClientRect()
    if (!r) return
    setPos({ top: r.bottom + 6, right: window.innerWidth - r.right })
    setOpen(true)
  }

  // 点外部关闭（含 portal 浮层本体；没有全局点击外块的框架，手挂监听）
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node
      if (rootRef.current?.contains(target)) return
      if (popoverRef.current?.contains(target)) return
      setOpen(false)
    }
    const onScroll = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  return (
    <div className="relative" ref={rootRef}>
      <button
        aria-expanded={open}
        aria-label="聊天记录"
        title="聊天记录"
        className="pointer-events-auto flex size-8 shrink-0 items-center justify-center rounded-[4px] text-muted-foreground transition-colors hover:text-foreground"
        data-slot="chat-history-button"
        onClick={() => (open ? setOpen(false) : openAt())}
        type="button"
      >
        <HistoryIcon className="size-[20px]" />
      </button>
      {open &&
        pos !== null &&
        createPortal(
          <div
            className="absolute z-50 max-h-[min(60vh,420px)] w-72 overflow-y-auto rounded-xl border border-(--stroke) bg-(--surface) p-1.5 shadow-(--shadow-pop)"
            data-slot="chat-history-popover"
            ref={popoverRef}
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
          >
            <div className="px-2 py-1.5 text-[11px] font-medium tracking-wide text-(--text-3)">
              聊天记录
            </div>
            {rows.length === 0 && (
              <div className="px-2 py-3 text-xs text-(--text-3)">当前会话还没有消息。</div>
            )}
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
              {rows.map((row) => (
                <li
                  className="rounded-lg px-2 py-1.5 hover:bg-foreground/[0.04]"
                  data-slot="chat-history-row"
                  key={row.id}
                >
                  <div className="flex items-center gap-2 text-[10px] text-(--text-3)">
                    <span className={row.role === 'user' ? 'text-(--brand)' : ''}>
                      {row.role === 'user' ? '你' : 'AI'}
                    </span>
                    {row.at !== null && (
                      <span className="tabular-nums">{TIME_FMT.format(row.at)}</span>
                    )}
                  </div>
                  <div className="truncate text-xs text-(--text)" title={row.text}>
                    {row.text}
                  </div>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </div>
  )
}
