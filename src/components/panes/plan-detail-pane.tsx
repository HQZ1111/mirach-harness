/**
 * 计划详情页（状态面板「会话计划」分区的落点；上游
 * `OpenPlanDetailSideTabRequest` 的宿主对偶 = 面板栏标签页）。
 *
 * 数据 = rpi-plan-mode 的 `plan-mode` 条目（`pi_plan_entries` 投影的
 * markdown 原文）；不解析、不改写——原文如实展示（宿主不引 markdown
 * 渲染依赖，等宽排版）。
 */
import { ScrollTextIcon } from 'lucide-react'

import type { PlanDetailPanePayload } from './status-pane-openers'

export function PlanDetailPane({ payload }: { payload: PlanDetailPanePayload }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-(--surface)" data-slot="plan-detail-pane">
      <div className="border-(--stroke-soft) flex items-center gap-2 border-b px-3 py-2">
        <span className="bg-foreground/[0.06] flex size-7 shrink-0 items-center justify-center rounded-md">
          <ScrollTextIcon className="text-(--text-3) size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-(--text) truncate text-[13px] font-semibold">
            {payload.title ?? '会话计划'}
          </div>
          <div className="text-(--text-4) truncate font-mono text-[11px]">{payload.entryId}</div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <pre className="text-(--text-2) bg-muted/40 rounded-lg p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap break-words">
          {payload.markdown}
        </pre>
      </div>
    </div>
  )
}
