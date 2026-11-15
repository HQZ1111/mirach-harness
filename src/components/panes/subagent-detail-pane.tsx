/**
 * 子代理详情页（2026-11-15）：从对话区子代理行/委托卡打开。
 *
 * 数据面（全部真值，不造会话、不造进度）：
 * - 工具结果 delegation payload：task/role/status/turns/maxTurns/timeout/
 *   report/childId/sessionId（`delegation-card.tsx::parseDelegationResult`）；
 * - `subagent` 工具行：agent 名 + task + 工具输出原文；
 * - `agent_hub` 进程级 registry 的 ChildEntry（按 childId 精确匹配）：
 *   状态、起止时间、输出字节数、transcript/steer 路径——这是 rpi 子代理
 *   的真实进度面（进程内 ChildAgent，无独立会话可切）。
 */
import { useEffect, useMemo } from 'react'
import { useStore } from 'zustand'
import { BotIcon } from 'lucide-react'
import {
  agentHubBridge,
  isSettled,
  type ChildEntry,
} from '@/components/assistant-ui/agent-hub-store'
import { cn } from '@/lib/utils'
import type { SubagentDetailPayload } from './subagent-detail-opener'

const STATUS_TEXT: Record<string, string> = {
  starting: '启动中',
  running: '运行中',
  done: '已完成',
  completed: '已完成',
  failed: '失败',
  error: '失败',
  timeout: '超时',
  timedOut: '超时',
  cancelled: '已取消',
  killed: '已终止',
}

const STATUS_TONE: Record<string, string> = {
  done: 'text-emerald-600 dark:text-emerald-400',
  completed: 'text-emerald-600 dark:text-emerald-400',
  failed: 'text-rose-600 dark:text-rose-400',
  error: 'text-rose-600 dark:text-rose-400',
  timeout: 'text-amber-600 dark:text-amber-400',
  timedOut: 'text-amber-600 dark:text-amber-400',
  cancelled: 'text-(--text-4)',
  killed: 'text-(--text-4)',
}

const statusText = (status: string | undefined, running: boolean): string => {
  if (running) return '运行中'
  if (!status) return ''
  return STATUS_TEXT[status] ?? status
}

const toneOf = (status: string | undefined, running: boolean): string => {
  if (running) return 'text-(--text-2)'
  return STATUS_TONE[status ?? ''] ?? 'text-(--text-3)'
}

/** 输出字节数 → 人类可读（二进制单位，技术规格）。 */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function formatClock(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
}

function elapsedLabel(entry: ChildEntry): string {
  const end = entry.finishedMs ?? (isSettled(entry.status) ? entry.startedMs : Date.now())
  const ms = Math.max(0, end - entry.startedMs)
  if (ms < 1000) return '<1 秒'
  const total = Math.round(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`
}

export function SubagentDetailPane({ payload }: { payload: SubagentDetailPayload }) {
  const children = useStore(agentHubBridge, (s) => s.children)
  const childId = payload.childId ?? null
  const entry = useMemo(
    () => (childId ? children.find((c) => c.id === childId) : undefined),
    [children, childId],
  )

  // 按 childId 精确匹配不到时拉一次名册（registry 是进程级真相）。失败在
  // store 内 console.error + 空投影，这里不假装有进度。
  useEffect(() => {
    if (childId && !entry) void agentHubBridge.getState().refresh()
  }, [childId, entry])

  const report = payload.report?.trim() ? payload.report : undefined
  const output = payload.output?.trim() ? payload.output : undefined
  const body = report ?? output
  const running = payload.running === true || entry?.status === 'running' || entry?.status === 'starting'
  const status = payload.status

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--surface)" data-slot="subagent-detail-pane">
      <div className="border-(--stroke-soft) flex items-center gap-2 border-b px-3 py-2">
        <span className="bg-foreground/[0.06] flex size-7 shrink-0 items-center justify-center rounded-md">
          <BotIcon className="text-(--text-3) size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-(--text) truncate text-[13px] font-semibold">
            {payload.name || '子代理'}
          </div>
          <div className="text-(--text-4) truncate text-[11px]" title={payload.task ?? ''}>
            {payload.task || '（无任务描述）'}
          </div>
        </div>
        <span
          data-slot="subagent-detail-status"
          className={cn(
            'shrink-0 text-[11px]',
            running && 'shimmer motion-reduce:animate-none',
            toneOf(status, running),
          )}
        >
          {statusText(status, running)}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          {payload.role ? (
            <>
              <dt className="text-(--text-4)">角色</dt>
              <dd className="text-(--text-2) font-mono">{payload.role}</dd>
            </>
          ) : null}
          {payload.turns !== undefined && payload.turns !== null ? (
            <>
              <dt className="text-(--text-4)">轮次</dt>
              <dd className="text-(--text-2) tabular-nums">
                {payload.turns}
                {payload.maxTurns !== undefined && payload.maxTurns !== null
                  ? `/${payload.maxTurns}`
                  : ''}
                {payload.turnLimited ? '（达到上限）' : ''}
              </dd>
            </>
          ) : null}
          {payload.timeoutSeconds !== undefined && payload.timeoutSeconds !== null ? (
            <>
              <dt className="text-(--text-4)">时限</dt>
              <dd className="text-(--text-2) tabular-nums">{payload.timeoutSeconds}s</dd>
            </>
          ) : null}
          {childId ? (
            <>
              <dt className="text-(--text-4)">子代理</dt>
              <dd className="text-(--text-2) truncate font-mono" title={childId}>
                {childId}
              </dd>
            </>
          ) : null}
          {payload.sessionId ? (
            <>
              <dt className="text-(--text-4)">会话</dt>
              <dd className="text-(--text-2) truncate font-mono" title={payload.sessionId}>
                {payload.sessionId}
              </dd>
            </>
          ) : null}
          {entry ? (
            <>
              <dt className="text-(--text-4)">进度</dt>
              <dd className="text-(--text-2)">
                {isSettled(entry.status) ? '已结束' : '进行中'} · 用时 {elapsedLabel(entry)} ·
                输出 {formatBytes(entry.outputBytes)}
              </dd>
              <dt className="text-(--text-4)">起止</dt>
              <dd className="text-(--text-2) tabular-nums">
                {formatClock(entry.startedMs)} → {entry.finishedMs ? formatClock(entry.finishedMs) : '—'}
              </dd>
              {entry.transcriptPath ? (
                <>
                  <dt className="text-(--text-4)">转录</dt>
                  <dd className="text-(--text-2) truncate font-mono" title={entry.transcriptPath}>
                    {entry.transcriptPath}
                  </dd>
                </>
              ) : null}
            </>
          ) : null}
        </dl>

        <div className="mt-3">
          <div className="text-(--text-4) mb-1 text-[11px]">
            {report ? '子代理报告' : output ? '工具输出' : '输出'}
          </div>
          {body !== undefined ? (
            <pre className="text-(--text-2) bg-muted/40 max-h-[60vh] overflow-auto rounded-lg p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap break-words">
              {body}
            </pre>
          ) : (
            <p className="text-(--text-4) text-[12px]">
              {running ? '子代理运行中，尚无输出。' : '引擎未返回子代理输出。'}
            </p>
          )}
        </div>

        {childId && !entry ? (
          <p className="text-(--text-4) mt-2 text-[11px]">
            名册里暂未找到该子代理（进程级 registry 可能已清理）；以上为工具结果中的事实。
          </p>
        ) : null}
      </div>
    </div>
  )
}
