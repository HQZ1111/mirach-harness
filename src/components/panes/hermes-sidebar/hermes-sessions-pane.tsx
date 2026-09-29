/**
 * hermes 会话列表侧栏（视觉移植：app/chat/sidebar 的 projects 概览 + 日期
 * 分桶 recents；数据=本地 mock 纯 UI，不接 hermes store/网关）。
 * 结构：项目概览行（色点+名+计数+caret）→ 日期分隔条 → 会话行
 * （状态点+标题+尾随时间，hover 显 ⋯）。搜索框过滤，行点击选中。
 */
import { useMemo, useState } from 'react'
import { MoreHorizontal, Search, SquarePen } from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  SidebarDateDivider,
  SidebarRowBody,
  SidebarRowLabel,
  SidebarRowLead,
  SidebarRowShell,
  SidebarSectionAddButton,
  SidebarSectionHeader,
} from './chrome'

interface MockSession {
  id: string
  title: string
  project: string | null // null = Home（无项目）
  bucket: 'today' | 'yesterday' | 'week'
  live: boolean
  unread: boolean
  ago: string
}

const MOCK_PROJECTS = [
  { id: 'p-mirach', name: 'mirach-harness', color: '#006fff' },
  { id: 'p-hermes', name: 'hermes-agent', color: '#16a34a' },
  { id: 'p-site', name: '官网改版', color: '#d97706' },
]

const MOCK_SESSIONS: MockSession[] = [
  { id: 's1', title: '布局引擎拖拽预览调优', project: 'p-mirach', bucket: 'today', live: true, unread: false, ago: '12:40' },
  { id: 's2', title: 'assistant-ui 接入排期', project: 'p-mirach', bucket: 'today', live: false, unread: true, ago: '11:02' },
  { id: 's3', title: '终端 PTY 调研', project: 'p-mirach', bucket: 'today', live: false, unread: false, ago: '09:31' },
  { id: 's4', title: '会话列表虚拟滚动', project: 'p-hermes', bucket: 'yesterday', live: false, unread: false, ago: '昨天' },
  { id: 's5', title: 'RPC 断线续传设计', project: 'p-hermes', bucket: 'yesterday', live: false, unread: false, ago: '昨天' },
  { id: 's6', title: '首页文案润色', project: 'p-site', bucket: 'week', live: false, unread: false, ago: '周三' },
  { id: 's7', title: '随手记：令牌命名规范', project: null, bucket: 'week', live: false, unread: false, ago: '周二' },
]

const BUCKET_LABEL: Record<MockSession['bucket'], string> = {
  today: '今天',
  yesterday: '昨天',
  week: '上周',
}
const BUCKETS: MockSession['bucket'][] = ['today', 'yesterday', 'week']

export function HermesSessionsPane() {
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState('s1')
  const [collapsedProjects, setCollapsedProjects] = useState<Record<string, boolean>>({})
  const [collapsedBuckets, setCollapsedBuckets] = useState<Record<string, boolean>>({})

  const sessions = useMemo(
    () => MOCK_SESSIONS.filter((s) => s.title.toLowerCase().includes(query.trim().toLowerCase())),
    [query],
  )

  const projectRows = useMemo(
    () =>
      MOCK_PROJECTS.map((p) => ({
        ...p,
        count: sessions.filter((s) => s.project === p.id).length,
      })),
    [sessions],
  )

  const renderRow = (s: MockSession, nested?: boolean) => (
    <SidebarRowShell
      className={cn(
        'group/row',
        nested && 'pl-3',
        selectedId === s.id && 'bg-[color-mix(in_srgb,var(--fl-accent)_10%,transparent)]',
      )}
      key={s.id}
      actions={
        <button
          aria-label="会话操作"
          className={cn(
            'mr-1 grid size-5 place-items-center rounded text-(--text-3) opacity-0 transition-opacity',
            'hover:bg-(--hover-wash) hover:text-(--text) group-hover/row:opacity-100',
          )}
          onClick={(e) => e.stopPropagation()}
          type="button"
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      }
    >
      <SidebarRowBody
        className={cn('flex min-h-9 items-center gap-2', s.live && 'text-(--text)')}
        onClick={() => setSelectedId(s.id)}
        type="button"
      >
        <SidebarRowLead>
          {s.live ? (
            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
          ) : s.unread ? (
            <span className="size-1.5 rounded-full bg-(--fl-accent)" />
          ) : (
            <span className="size-1.5 rounded-full bg-(--stroke)" />
          )}
        </SidebarRowLead>
        <SidebarRowLabel className={cn(s.unread && 'font-semibold text-(--text)')}>{s.title}</SidebarRowLabel>
        <span className="ml-auto shrink-0 pr-1 text-[0.625rem] leading-none text-(--text-4)">{s.ago}</span>
      </SidebarRowBody>
    </SidebarRowShell>
  )

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--surface)">
      {/* 搜索 + 新建（hermes 侧栏顶排） */}
      <div className="flex items-center gap-1.5 px-2 pt-2">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-(--stroke-soft) bg-transparent px-2">
          <Search className="size-3 shrink-0 text-(--text-4)" />
          <input
            className="h-full w-full bg-transparent text-xs text-(--text) outline-none placeholder:text-(--text-4)"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索会话"
            value={query}
          />
        </div>
        <button
          aria-label="新建会话"
          className="grid size-7 shrink-0 place-items-center rounded-md border border-(--stroke-soft) text-(--text-2) hover:bg-(--hover-wash)"
          title="新建会话"
          type="button"
        >
          <SquarePen className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {/* 项目概览（hermes projectOverview：色点+名+计数+caret，Home 在首） */}
        <SidebarSectionHeader
          action={<SidebarSectionAddButton ariaLabel="新建项目" onPlainClick={() => {}} />}
          label="项目"
        />
        <div className="grid grid-cols-[minmax(0,1fr)] gap-px">
          <SidebarRowShell className="group/row">
            <SidebarRowBody className="flex min-h-8 items-center gap-2" type="button">
              <SidebarRowLead>
                <span className="size-2 rounded-full bg-(--stroke)" />
              </SidebarRowLead>
              <SidebarRowLabel>Home</SidebarRowLabel>
              <span className="ml-auto pr-1 text-[0.625rem] text-(--text-4)">
                {sessions.filter((s) => !s.project).length}
              </span>
            </SidebarRowBody>
          </SidebarRowShell>
          {projectRows.map((p) => {
            const open = !collapsedProjects[p.id]
            return (
              <SidebarRowShell className="group/row" key={p.id}>
                <SidebarRowBody
                  className="flex min-h-8 items-center gap-2"
                  onClick={() => setCollapsedProjects((m) => ({ ...m, [p.id]: open }))}
                  type="button"
                >
                  <SidebarRowLead>
                    <span className="size-2 rounded-full" style={{ background: p.color }} />
                  </SidebarRowLead>
                  <SidebarRowLabel>{p.name}</SidebarRowLabel>
                  <span className="ml-auto pr-1 text-[0.625rem] text-(--text-4)">{p.count}</span>
                  <ChevronCaret open={open} />
                </SidebarRowBody>
              </SidebarRowShell>
            )
          })}
        </div>

        {/* 日期分桶 recents（hermes groupEntriesByRecency 视觉） */}
        <SidebarSectionHeader
          action={<SidebarSectionAddButton ariaLabel="新建会话" onPlainClick={() => {}} />}
          label="会话"
        />
        {BUCKETS.map((bucket) => {
          const rows = sessions.filter((s) => s.bucket === bucket)
          if (rows.length === 0) return null
          const open = !collapsedBuckets[bucket]
          return (
            <div key={bucket}>
              <SidebarDateDivider
                label={BUCKET_LABEL[bucket]}
                onToggle={() => setCollapsedBuckets((m) => ({ ...m, [bucket]: open }))}
                open={open}
              />
              {open && <div className="grid grid-cols-[minmax(0,1fr)] gap-px">{rows.map((s) => renderRow(s))}</div>}
            </div>
          )
        })}
        {sessions.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-(--text-4)">没有匹配的会话</div>
        )}
      </div>
    </div>
  )
}

function ChevronCaret({ open }: { open: boolean }) {
  return (
    <svg
      className={cn('size-3 shrink-0 text-(--text-3) opacity-0 transition group-hover/row:opacity-100', open && 'rotate-90')}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      viewBox="0 0 24 24"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}
