/**
 * 输入框上的「文件夹位置」选项 —— ZCode `project-sidebar/ProjectComposerMenu`
 * 的 mirach 适配（2026-11-01 用户："新建任务的时候输入框上加个文件夹的位置
 * 选项，也直接用zcode的"）。
 *
 * **形态对齐上游**：composer 卡片内第一行的圆角胶囊 chip（FolderIcon +
 * 工作区名 + ChevronDown），点开 `side="top"` 菜单（上游同向）：
 * 顶部搜索框（`command-input-wrapper` 包一层 `onKeyDown stopPropagation`，
 * 防 typeahead 抢键——上游同款手法）+ 可滚动的工作区列表 + 尾部动作行。
 *
 * **数据面换宿主真相**：上游的"项目"实体（projects store / 远程设备 /
 * 创建项目对话框）宿主没有——harness 的工作区真相 = 会话 cwd。列表 =
 * **最近工作区**（sessionCatalog entries 的 distinct cwd，按最近使用排），
 * 尾部动作 = 「选择文件夹…」（@tauri-apps/plugin-dialog，与文件树窗格
 * 同款系统对话框）。没有的项目创建/远程连接/「不在项目中工作」不列假入口。
 *
 * **选择即建会话**（上游 createProjectTask 语义）：选中目录 →
 * sessionWorkspaceStore.requestCreate(cwd) → runtime 执行器 pi_new_session
 * （working_directory 透传）。必须在首条消息**前**建——pi 的懒创建会话用
 * 进程默认 cwd，pendingCwd 不参与，懒创建会让"选了文件夹"落空。
 *
 * **只在新建任务时显示**（上游只挂 draft composer 同语义）：会话目录的
 * activeId === null（New Chat / 启动无会话 / 删除活动会话）时渲染，
 * 有活动会话即卸载。
 */
import { useMemo, useState } from 'react'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { useStore } from 'zustand'
import {
  ChevronDownIcon,
  FolderIcon,
  FolderOpenIcon,
  SearchIcon,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import {
  ContextMenu,
  ContextMenuAnchor,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/motion/context-menu'
import {
  sessionCatalog,
  sessionProjectCwd,
} from '@/components/panes/session-manage/session-catalog'
import { sessionWorkspaceStore } from '@/components/panes/session-manage/session-workspace'

const pathLeaf = (path: string): string => {
  const normalized = path.replace(/[\\/]+$/, '')
  const idx = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

/** 最近工作区（distinct cwd，最近使用在前；空 cwd 不进列）。 */
const recentWorkspaces = (
  entries: Record<string, { cwd?: string; lastModifiedMs?: number }>,
): { cwd: string; lastModifiedMs: number }[] => {
  const byCwd = new Map<string, number>()
  for (const entry of Object.values(entries)) {
    if (typeof entry.cwd !== 'string' || entry.cwd.length === 0) continue
    const last = entry.lastModifiedMs ?? 0
    byCwd.set(entry.cwd, Math.max(byCwd.get(entry.cwd) ?? 0, last))
  }
  return [...byCwd.entries()]
    .map(([cwd, lastModifiedMs]) => ({ cwd, lastModifiedMs }))
    .sort((left, right) => right.lastModifiedMs - left.lastModifiedMs)
    .slice(0, 8)
}

export function WorkspaceComposerMenu() {
  // 「新建任务」判定：activeId === null（New Chat / 启动无会话 / 删除活动
  // 会话后 runtime 都把 currentThreadId 置 null → catalog.setActive(null)）
  const activeId = useStore(sessionCatalog, (s) => s.activeId)
  const entries = useStore(sessionCatalog, (s) => s.entries)
  const pendingCwd = useStore(sessionCatalog, (s) => s.pendingCwd)
  const cwd = sessionProjectCwd(
    activeId ? entries[activeId] : undefined,
    pendingCwd,
  )

  const [query, setQuery] = useState('')
  const [dialogError, setDialogError] = useState<string | null>(null)
  const recents = useMemo(() => recentWorkspaces(entries), [entries])
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return recents
    return recents.filter(
      (r) => pathLeaf(r.cwd).toLowerCase().includes(q) || r.cwd.toLowerCase().includes(q),
    )
  }, [recents, query])

  // 选择即建会话（见文件头「选择即建会话」）：请求-执行桥，真相在 runtime。
  const createIn = (dir: string) => {
    sessionWorkspaceStore.getState().requestCreate(dir)
  }

  const pickFolder = async () => {
    setDialogError(null)
    try {
      // 系统文件夹对话框（@tauri-apps/plugin-dialog，与文件树窗格同款）
      const dir = await openFileDialog({ directory: true })
      if (typeof dir !== 'string' || dir.length === 0) return // 用户取消——不发请求
      createIn(dir)
    } catch (e) {
      // 对话框失败（宿主权限/环境）——错误可见，不假装成功
      console.error('[workspace-menu] 打开文件夹对话框失败', e)
      setDialogError(String(e))
    }
  }

  // 有活动会话 → 不渲染（组件自我裁剪，调用点无需知道会话态）
  if (activeId !== null) return null

  const title = cwd ? pathLeaf(cwd) : '选择文件夹'

  return (
    <ContextMenu align="start" anchor="trigger" side="top" sideOffset={6}>
      <ContextMenuAnchor>
        <button
          type="button"
          aria-label="选择文件夹位置"
          data-slot="workspace-composer-trigger"
          className={cn(
            'text-(--text) hover:bg-(--hover-wash) flex h-8 min-w-0 max-w-[15rem] items-center gap-1.5 rounded-full py-1.5 pr-2 pl-3 text-[12.5px] transition-colors focus-visible:ring-foreground/20 focus-visible:ring-2 focus-visible:outline-none',
          )}
        >
          <FolderIcon
            className="text-(--text-3) size-4 shrink-0 transition-opacity"
            aria-hidden="true"
          />
          <span className="block max-w-full truncate" title={cwd ?? undefined}>
            {title}
          </span>
          <ChevronDownIcon className="text-(--text-3) size-3.5 shrink-0" aria-hidden="true" />
        </button>
      </ContextMenuAnchor>
      <ContextMenuContent
        ariaLabel="选择文件夹位置"
        className="w-72 p-0"
      >
        {/* 搜索框包一层 stopPropagation：菜单 typeahead 会截走单字符键（上游
            command-input-wrapper 同款手法）；Esc 不关闭（与上游一致） */}
        <div
          data-slot="workspace-search-wrapper"
          className="border-foreground/[0.06] shrink-0 border-b p-1"
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="bg-foreground/[0.04] flex h-8 items-center gap-2 rounded-lg px-2.5">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索最近的工作区"
              className="text-(--text) placeholder:text-(--text-4) h-full w-full bg-transparent text-[13px] outline-none"
            />
            <SearchIcon className="text-(--text-4) size-4 shrink-0" aria-hidden="true" />
          </div>
        </div>
        <div className="flex min-h-0 flex-col p-1">
          {dialogError !== null && (
            <div role="alert" className="text-destructive px-2 py-2 text-[12px]">
              {dialogError}
            </div>
          )}
          <div className="max-h-60 min-h-0 overflow-y-auto">
            {visible.map((r) => (
              <ContextMenuCheckboxItem
                key={r.cwd}
                checked={cwd === r.cwd}
                textValue={pathLeaf(r.cwd)}
                // CheckboxItem 的 onSelect 被换成 onCheckedChange(!checked)——
                // 这里无论新选还是点当前项都执行"在此目录新建会话"（与上游
                // DropdownMenuCheckboxItem onSelect 语义一致）
                onCheckedChange={() => createIn(r.cwd)}
              >
                <FolderIcon className="text-(--text-3) size-4 shrink-0" aria-hidden="true" />
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate">{pathLeaf(r.cwd)}</span>
                  <span
                    className="text-(--text-4) max-w-36 truncate text-[11px]"
                    title={r.cwd}
                  >
                    {r.cwd}
                  </span>
                </span>
              </ContextMenuCheckboxItem>
            ))}
            {visible.length === 0 && (
              <div className="text-(--text-4) px-2 py-2 text-[13px]">没有找到匹配的工作区</div>
            )}
          </div>
          <div className="shrink-0">
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => void pickFolder()}>
              <FolderOpenIcon className="text-(--text-3) size-4 shrink-0" aria-hidden="true" />
              <span>选择文件夹…</span>
            </ContextMenuItem>
          </div>
        </div>
      </ContextMenuContent>
    </ContextMenu>
  )
}
