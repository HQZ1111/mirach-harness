/**
 * 已结束智能体目录页（状态面板「智能体」分区页脚行的落点；上游
 * `OpenSubagentDirectorySideTabRequest` 的宿主对偶 = 面板栏标签页）。
 *
 * 数据 = 本线程工具调用派生（`status-agent-rows.ts` 的 ended 段），
 * 与面板页脚计数同源；点击行开子代理详情页（既有通道）。
 */
import { useAuiState } from '@assistant-ui/react'
import { useMemo } from 'react'
import { BotIcon, ChevronRightIcon } from 'lucide-react'

import { deriveAgentRows } from '@/components/assistant-ui/status-agent-rows'
import { openSubagentDetail } from '@/components/panes/subagent-detail-opener'

export function AgentDirectoryPane() {
  const messages = useAuiState((s) => s.thread.messages)
  const ended = useMemo(
    () => deriveAgentRows(messages as readonly unknown[]).ended,
    [messages],
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--surface)" data-slot="agent-directory-pane">
      <div className="border-(--stroke-soft) flex items-center gap-2 border-b px-3 py-2">
        <span className="bg-foreground/[0.06] flex size-7 shrink-0 items-center justify-center rounded-md">
          <BotIcon className="text-(--text-3) size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-(--text) truncate text-[13px] font-semibold">
            已结束的智能体 · {ended.length}
          </div>
          <div className="text-(--text-4) truncate text-[11px]">
            本次会话里已结束的子代理调用（点击查看详情）。
          </div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {ended.length === 0 ? (
          <p className="text-(--text-4) px-2 py-2 text-[12px]">还没有已结束的智能体。</p>
        ) : (
          ended.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => openSubagentDetail(row.payload)}
              className="hover:bg-foreground/[0.04] flex w-full min-w-0 items-start gap-2 rounded-lg px-2 py-2 text-left transition-colors"
            >
              <BotIcon className="text-(--text-3) mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="text-(--text) line-clamp-2 text-[13px] leading-5">{row.title}</span>
                <span className="text-(--text-4) text-[12px] tabular-nums">
                  {row.status ?? '已结束'}
                  {row.completedAt !== null
                    ? ` · ${new Date(row.completedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
                    : ''}
                </span>
              </span>
              <ChevronRightIcon className="text-(--text-4) mt-0.5 size-4 shrink-0" />
            </button>
          ))
        )}
      </div>
    </div>
  )
}
