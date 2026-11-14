/**
 * `@/components/ui/sidebar` 的**裁剪副本**（2026-10-29）。
 *
 * 上游是 677 行的完整 shadcn sidebar（Provider / 折叠状态机 / Mobile 抽屉 /
 * Sheet / Context / Rail / Inset / Trigger / 键盘快捷键 Ctrl+B）。定时任务的
 * 侧栏区（`app/chat/sidebar/cron-jobs-section.tsx:10`）只用到两个导出：
 * `SidebarGroup` 与 `SidebarGroupContent`——都是纯 div 包装。
 *
 * **裁剪口径**（与 AGENTS.md「beui 组件：本地副本与上游的关系」同一条规矩）：
 * 页面级骨架与陷阱删掉，用到的实现**逐字照抄**。所以这里的 `SidebarGroup` /
 * `SidebarGroupContent` 与上游 `sidebar.tsx:354` / `:409` 字节一致，只删掉了
 * 本页不用的导出及其依赖（`use-mobile`、`sheet`、`SidebarProvider` 等）——
 * 那些会把整棵移动端骨架拖进来，而定时任务侧栏区在桌面三栏里根本用不到。
 *
 * **将来若要完整侧栏**：从上游整体覆盖本文件，并把 `use-mobile` / `sheet`
 * 一起拷进 mirror。不要在这里逐个补导出——那会得到一份"半骨架"，两边都不像。
 */

import type * as React from 'react'

import { cn } from '@/hermes-shim/lib/utils'

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('relative flex w-full min-w-0 flex-col p-2', className)}
      data-sidebar="group"
      data-slot="sidebar-group"
      {...props}
    />
  )
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn('w-full text-sm', className)}
      data-sidebar="group-content"
      data-slot="sidebar-group-content"
      {...props}
    />
  )
}

export { SidebarGroup, SidebarGroupContent }
