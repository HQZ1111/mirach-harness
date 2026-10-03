/**
 * 标签总览面板（**ZCode SidePaneTabOverview 逐结构照抄**，用户 2026-10-03
 * 指令"去 zcode 的源码抄"）：cmdk Command 面板——搜索框 + "打开的标签页"
 * 分组 + 类型图标 + 标签名 + 相对时间 + ✕ 关闭。
 *
 * **触发与数据全部来自 flexlayout 原生溢出体系**（不自建按钮）：
 * tabs 超宽被裁 → 原生溢出按钮（icons.more 替换为双 chevron）出现 →
 * Layout 的 onShowOverflowMenu 回调把 items（hiddenTabs）与本组件挂载。
 * TabNode 无 openedAt——模块级 Map 首见时间补（ZCode openedAt 对应物）；
 * 相对时间复用 sessionRowAge（刚刚/天/时/分，与侧栏行 age 同源同文案）。
 * 搜索评分照抄 ZCode sidePaneTabSearch.ts（title 前缀/词首/包含加权）。
 * 最近关闭组（ZCode recentClosedTabs）待 tab 关闭历史数据面，TODO。
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { Popover } from 'radix-ui'
import { Command } from 'cmdk'
import {
  BotIcon,
  EyeIcon,
  FileDiffIcon,
  FolderIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  SquareTerminalIcon,
  XIcon,
} from 'lucide-react'
import { Actions, TabNode, TabSetNode } from 'flexlayout-react'
import { closePane, PANE_TYPES, paneTypeOf } from './pane-registry'
import { useLayoutStore } from '@/store/layout-store'
import { useStore } from 'zustand'
import { sessionRowAge } from '@/components/panes/session-manage/session-time'

/** tab 首见时间（flexlayout TabNode 无时间戳——ZCode openedAt 对应物）。 */
const openedAtByTabId = new Map<string, number>()

const rememberOpenedAt = (tabs: { node: TabNode }[]): void => {
  for (const t of tabs) {
    if (!openedAtByTabId.has(t.node.getId())) openedAtByTabId.set(t.node.getId(), Date.now())
  }
}

/** 类型图标（ZCode SidePaneTabIcon 的 harness 对应面——按 pane 类型）。 */
const TYPE_ICONS: Record<string, ReactElement> = {
  sessions: <MessagesSquareIcon size={14} />,
  bots: <BotIcon size={14} />,
  workspace: <MessageSquareTextIcon size={14} />,
  session: <MessageSquareTextIcon size={14} />,
  files: <FolderIcon size={14} />,
  review: <FileDiffIcon size={14} />,
  terminal: <SquareTerminalIcon size={14} />,
  preview: <EyeIcon size={14} />,
}

interface TabMeta {
  id: string
  name: string
  typeLabel: string
  closeable: boolean
  openedAt: number
  search: { title: string; typeLabel: string; all: string }
}

// ── 搜索（ZCode sidePaneTabSearch.ts 照抄：词首/包含加权） ─────────────────

const normalizeSearchText = (value: string): string => value.trim().toLocaleLowerCase()

const normalizeSearchQuery = (query: string): string[] =>
  normalizeSearchText(query).split(/\s+/).filter(Boolean)

const hasWordPrefix = (value: string, part: string): boolean =>
  value.split(/[\s/_.:-]+/).some((word) => word.startsWith(part))

const getSearchScore = (
  fields: { title: string; typeLabel: string; all: string },
  queryParts: string[],
): number => {
  if (!queryParts.every((part) => fields.all.includes(part))) return 0
  return queryParts.reduce((score, part) => {
    if (fields.title.startsWith(part)) return score + 120
    if (hasWordPrefix(fields.title, part)) return score + 90
    if (fields.title.includes(part)) return score + 70
    if (fields.typeLabel.includes(part)) return score + 20
    return score + 1
  }, 0)
}

export function TabOverviewMenu({
  anchor,
  tabset,
  onClose,
}: {
  anchor: { x: number; y: number }
  /** 所属 tabset——面板显示**全部打开的标签**（ZCode「打开的标签页」=全量，
   *  不只溢出被裁的 hiddenTabs；跳转走 selectTab，原生会滚入视图）。 */
  tabset: import('flexlayout-react').TabSetNode | import('flexlayout-react').BorderNode
  onClose: () => void
}): ReactElement {
  const [query, setQuery] = useState('')
  const [nowMs, setNowMs] = useState(() => Date.now())

  // 全部 tab：**每次渲染现取**（面板开着点 ✕ 关闭后必须立即消失——
  // useMemo([tabset]) 会因 flexlayout 就地变异节点而永不重算，留下
  // "关不掉、点不动"的幽灵行，审查 C-2）。layoutRev 订阅承载重渲。
  const layoutRev = useLayoutStore((s) => s.layoutRev)
  void layoutRev
  const allTabs = tabset.getChildren().filter((c): c is TabNode => c instanceof TabNode)
  const selectedId = tabset instanceof TabSetNode ? tabset.getSelectedNode()?.getId() : undefined

  rememberOpenedAt(allTabs.map((node) => ({ node })))

  const queryParts = useMemo(() => normalizeSearchQuery(query), [query])
  const metas = useMemo<TabMeta[]>(
    () =>
      allTabs.map((node) => {
        const id = node.getId()
        let openedAt = openedAtByTabId.get(id)
        if (openedAt === undefined) {
          openedAt = Date.now()
          openedAtByTabId.set(id, openedAt)
        }
        const ptype = paneTypeOf(id)
        const name = node.getName() || '(未命名)'
        const typeLabel = ptype ? (PANE_TYPES[ptype]?.name ?? '') : ''
        return {
          id,
          name,
          typeLabel,
          closeable: node.isEnableClose(),
          openedAt,
          search: {
            title: normalizeSearchText(name),
            typeLabel: normalizeSearchText(typeLabel),
            all: normalizeSearchText(`${name} ${typeLabel}`),
          },
        }
      }),
    [allTabs],
  )
  const filtered = useMemo(
    () => {
      // ZCode filterAndRankSearchItems 的空查询早退——缺失会把全部条目
      // 滤空（空 queryParts 的 reduce 初值 0，score>0 过滤后无一幸免）。
      if (queryParts.length === 0) return metas
      return metas
        .map((m, index) => ({ m, index, score: getSearchScore(m.search, queryParts) }))
        .filter((e) => e.score > 0)
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .map((e) => e.m)
    },
    [metas, queryParts],
  )

  // 面板开着时每 60s 刷新 nowMs——相对时间保持新鲜（ZCode 同款 interval）。
  useEffect(() => {
    setNowMs(Date.now())
    const interval = window.setInterval(() => setNowMs(Date.now()), 60_000)
    return () => window.clearInterval(interval)
  }, [])

  return (
    <Popover.Root open onOpenChange={(next) => { if (!next) onClose() }}>
      <Popover.Anchor
        virtualRef={{
          current: {
            getBoundingClientRect: () => new DOMRect(anchor.x, anchor.y, 0, 0),
          },
        }}
      />
      <Popover.Portal>
        <Popover.Content
          align="start"
          className="tab-overflow-menu"
          collisionPadding={8}
          side="bottom"
          sideOffset={6}
        >
          <Command loop shouldFilter={false} className="tab-overview-cmd">
            <Command.Input
              autoFocus
              className="tab-overview-input"
              onValueChange={setQuery}
              placeholder="搜索标签页..."
              value={query}
            />
            <Command.List className="tab-overview-list">
              <Command.Empty className="tab-overview-empty">没有匹配的标签页</Command.Empty>
              {filtered.length > 0 && (
                <Command.Group className="tab-overview-group" heading="打开的标签页">
                  {filtered.map((t) => (
                    <Command.Item
                      className={`tab-overview-item${t.id === selectedId ? ' active' : ''}`}
                      key={t.id}
                      keywords={[t.typeLabel]}
                      onSelect={() => {
                        // 跳转走 selectTab——溢出被裁的 tab 原生会滚入视图
                        const m = (
                          globalThis as unknown as { __flModel?: { doAction: (a: unknown) => void } }
                        ).__flModel
                        m?.doAction(Actions.selectTab(t.id))
                        onClose()
                      }}
                      value={t.name}
                    >
                      <span className="tab-overview-icon">
                        {TYPE_ICONS[paneTypeOf(t.id) ?? ''] ?? <MessageSquareTextIcon size={14} />}
                      </span>
                      <span className="tab-overview-name">{t.name}</span>
                      <span className="tab-overview-age">{sessionRowAge(t.openedAt, undefined, nowMs)}</span>
                      {t.closeable && (
                        <button
                          aria-label={`关闭 ${t.name}`}
                          className="tab-overview-close"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            const m = (
                              globalThis as unknown as { __flModel?: Parameters<typeof closePane>[0] }
                            ).__flModel
                            if (m) closePane(m, t.id)
                          }}
                          onPointerDown={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                          }}
                          type="button"
                        >
                          <XIcon size={12} />
                        </button>
                      )}
                    </Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}