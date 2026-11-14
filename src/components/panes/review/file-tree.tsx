/**
 * 审查变更文件树 —— hermes 桌面端
 * `app/right-sidebar/review/file-tree.tsx`（533 行）的移植。
 *
 * 两种布局（树 / 平铺列表）、重列表虚拟化（@tanstack/react-virtual，>60 节点
 * 才启用）、逐行动画（motion layout spring）、单双击分流（单击看内联 diff、
 * 双击在主预览打开）、拖到 composer（`application/x-mirach-paths`）、右键菜单。
 *
 * 与上游的差异（都是宿主事实，就地注释）：
 * - 上游 `Codicon` 用 codicon 字体 → 宿主同名同源（@vscode/codicons）。
 * - 上游 `$sidebarWorkspaceNodeOpen`（布局 store 的树折叠表）→ 宿主本地
 *   state（审查树与工作区文件树不同源，独立折叠表；上游其实也用了同一个
 *   全局表，这里为免与文件树互相干扰而独立）。
 * - 上游 `openPreview(normalizeOrLocalPreviewTarget(path))` → 宿主
 *   `openFilePreview`（预览面板通道，与文件树同一入口）。
 * - 上游 `revealFileInTree` / `revealFile` / `copyFilePath` / `downloadRemoteFile`
 *   （文件树 + 桌面桥）→ 宿主只保留 `copyFilePath`（剪贴板）与
 *   `revealFileInTree`（若文件树已打开该目录则定位；没有则为 no-op + 日志）。
 * - 上游 `ContextMenu`（Radix）→ 宿主 beui ContextMenu（全应用唯一弹层来源）。
 * - 上游 `isDesktopFsRemoteMode()` 的远端下载分支：宿主无远端模式 → 不渲染。
 */

import { useVirtualizer } from '@tanstack/react-virtual'
import { AnimatePresence, motion } from 'motion/react'
import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/motion/context-menu'
import { useReview, type ReviewFile } from '@/components/panes/review-store'
import { Codicon } from '@/components/ui/codicon'
import { DiffCount } from '@/components/ui/diff-count'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tip'
import { openFilePreview } from '@/components/panes/hermes-sidebar/preview-opener'
import { cn } from '@/lib/utils'

import {
  buildReviewFlatList,
  buildReviewTree,
  countAllNodes,
  flattenReviewRows,
  type ReviewFlatRow,
  type ReviewTreeNode,
} from './tree-data'

const INDENT = 12

// Per git status letter: a tinted diff codicon so the file's nature reads at a
// glance (added / modified / deleted / renamed / untracked).
const STATUS_GLYPH: Record<string, { icon: string; tone: string }> = {
  A: { icon: 'diff-added', tone: 'text-(--ui-green)' },
  C: { icon: 'diff-added', tone: 'text-(--ui-green)' },
  D: { icon: 'diff-removed', tone: 'text-(--ui-red)' },
  M: { icon: 'diff-modified', tone: 'text-amber-500/85' },
  R: { icon: 'diff-renamed', tone: 'text-sky-500/85' },
  U: { icon: 'warning', tone: 'text-(--ui-red)' },
  '?': { icon: 'diff-added', tone: 'text-muted-foreground/60' },
}

// Review paths are repo-relative; the composer drop expects absolute paths, so
// join against the pane's repo.
function absolutePath(relative: string, repoCwd: string): string {
  if (/^([a-zA-Z]:[\\/]|\/)/.test(relative)) {
    return relative
  }
  const cwd = repoCwd.replace(/[\\/]+$/, '')
  return cwd ? `${cwd}/${relative}` : relative
}

// Fast, layout-aware row: `layout` slides siblings when one is inserted/removed,
// AnimatePresence fades the enter/exit. A tight, near-critically-damped spring
// keeps it crisp (quick settle, no bounce) so adds/deletes read as snappy.
const ROW_TRANSITION = { type: 'spring', stiffness: 1100, damping: 48, mass: 0.32 } as const

// Instant (no animation) — used while the pane is settling open.
const ROW_INSTANT = { duration: 0 } as const

// Past this many visible rows, drop the animated list and virtualize.
const HEAVY_LIST_CAP = 60

// Uniform row height (h-6 = 1.5rem). Every review row is this exact height.
const ROW_HEIGHT = 24

// Rows mounted above and below the viewport while scrolling.
const OVERSCAN_ROWS = 12

/** 折叠表（上游 `$sidebarWorkspaceNodeOpen` 的宿主对偶；键 = `review:<id>`）。 */
function useNodeOpenMap() {
  const [nodeOpen, setNodeOpen] = useState<Record<string, boolean>>({})
  const toggle = (id: string, defaultOpen: boolean) =>
    setNodeOpen((prev) => ({ ...prev, [id]: !(prev[id] ?? defaultOpen) }))
  return { nodeOpen, toggle }
}

export function ReviewFileTree() {
  const files = useReview((s) => s.files)
  const loading = useReview((s) => s.loading)
  const mode = useReview((s) => s.treeMode)

  const tree = useMemo(
    () => (mode === 'tree' ? buildReviewTree(files) : buildReviewFlatList(files)),
    [files, mode],
  )

  // Heavy is decided by the TOTAL node count, not the top-level row count.
  const heavy = useMemo(() => countAllNodes(tree) > HEAVY_LIST_CAP, [tree])

  const { nodeOpen, toggle } = useNodeOpenMap()

  const rows = useMemo(() => {
    if (!heavy) return []
    return flattenReviewRows(tree, (id) => nodeOpen[`review:${id}`] ?? false)
  }, [heavy, nodeOpen, tree])

  const scrollerRef = useRef<HTMLDivElement | null>(null)

  // 首次刷新落地前不播入场动画（面板常驻，打开时不该整批飞入）。
  const [animate, setAnimate] = useState(false)
  const armed = useRef(false)

  useEffect(() => {
    if (loading) {
      armed.current = false
      setAnimate(false)
    }
  }, [loading])

  useEffect(() => {
    if (!loading && !armed.current) {
      armed.current = true
      const id = requestAnimationFrame(() => setAnimate(true))
      return () => cancelAnimationFrame(id)
    }
  }, [loading])

  return (
    <div
      className='min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-1 py-1'
      data-suppress-pane-reveal-side=''
      ref={scrollerRef}
    >
      {heavy ? (
        <VirtualizedReviewList nodeOpen={nodeOpen} rows={rows} scrollRef={scrollerRef} toggle={toggle} />
      ) : (
        <ReviewNodeList animate={animate} depth={0} nodeOpen={nodeOpen} nodes={tree} toggle={toggle} />
      )}
    </div>
  )
}

interface NodeListProps {
  animate: boolean
  depth: number
  nodeOpen: Record<string, boolean>
  nodes: ReviewTreeNode[]
  toggle: (id: string, defaultOpen: boolean) => void
}

function ReviewNodeList({ animate, depth, nodeOpen, nodes, toggle }: NodeListProps) {
  return (
    <AnimatePresence initial={false}>
      {nodes.map((node) => (
        <motion.div
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -2 }}
          initial={animate ? { opacity: 0, y: -4 } : false}
          key={node.id}
          layout='position'
          transition={animate ? ROW_TRANSITION : ROW_INSTANT}
        >
          {node.isDir ? (
            <ReviewDirRow animate={animate} depth={depth} node={node} nodeOpen={nodeOpen} toggle={toggle} />
          ) : (
            <ReviewFileRow depth={depth} node={node} />
          )}
        </motion.div>
      ))}
    </AnimatePresence>
  )
}

/**
 * 虚拟化的重列表：只挂视口内的行（+ overscan）。文件夹渲染成 `leaf` 行——
 * 子行来自摊平列表，不是内联递归——所以展开只是让列表变长。
 */
function VirtualizedReviewList({
  nodeOpen,
  rows,
  scrollRef,
  toggle,
}: {
  nodeOpen: Record<string, boolean>
  rows: ReviewFlatRow[]
  scrollRef: React.RefObject<HTMLDivElement | null>
  toggle: (id: string, defaultOpen: boolean) => void
}) {
  const virtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => rows[index]?.node.id ?? index,
    getScrollElement: () => scrollRef.current,
    // jsdom-friendly default; the real rect takes over on first observe.
    initialRect: { height: 600, width: 240 },
    overscan: OVERSCAN_ROWS,
  })

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  return (
    <div className='relative' style={{ height: totalSize }}>
      {virtualItems.map((virtualItem) => {
        const row = rows[virtualItem.index]

        if (!row) {
          return null
        }

        return (
          <div
            data-index={virtualItem.index}
            key={row.node.id}
            ref={virtualizer.measureElement}
            style={{
              left: 0,
              position: 'absolute',
              top: 0,
              transform: `translateY(${virtualItem.start}px)`,
              width: '100%',
            }}
          >
            {row.node.isDir ? (
              <ReviewDirRow
                animate={false}
                defaultOpen={false}
                depth={row.depth}
                leaf
                node={row.node}
                nodeOpen={nodeOpen}
                toggle={toggle}
              />
            ) : (
              <ReviewFileRow depth={row.depth} node={row.node} />
            )}
          </div>
        )
      })}
    </div>
  )
}

// Depth-0 rows align their icon to the panel header's glyph.
const ROW_BASE_INSET = 14

function rowStyle(depth: number): CSSProperties {
  return { paddingLeft: `${depth * INDENT + ROW_BASE_INSET}px` }
}

function ReviewDirRow({
  animate,
  defaultOpen = true,
  depth,
  leaf = false,
  node,
  nodeOpen,
  toggle,
}: {
  animate: boolean
  defaultOpen?: boolean
  depth: number
  /** Virtualized rows render their children from the flattened row list. */
  leaf?: boolean
  node: ReviewTreeNode
  nodeOpen: Record<string, boolean>
  toggle: (id: string, defaultOpen: boolean) => void
}) {
  const id = `review:${node.id}`
  const open = nodeOpen[id] ?? defaultOpen

  return (
    <>
      <div
        className='row-hover flex h-6 select-none items-center gap-1.5 rounded-md pr-1.5 text-xs text-(--ui-text-secondary) hover:text-foreground'
        onClick={() => toggle(id, defaultOpen)}
        style={rowStyle(depth)}
      >
        <Codicon className='shrink-0 text-(--ui-text-tertiary)' name={open ? 'folder-opened' : 'folder'} size='0.8rem' />
        <span className='min-w-0 flex-1 truncate' title={node.name}>
          {node.name}
        </span>
        {!open && <DiffCount added={node.added} className='text-[0.64rem] leading-4' removed={node.removed} />}
      </div>
      {!leaf && open && node.children && (
        <ReviewNodeList animate={animate} depth={depth + 1} nodeOpen={nodeOpen} nodes={node.children} toggle={toggle} />
      )}
    </>
  )
}

function ReviewFileRow({ node, depth }: { node: ReviewTreeNode; depth: number }) {
  const selectedPath = useReview((s) => s.selectedPath)
  const repoCwd = useReview((s) => s.repoCwd)
  const selectFile = useReview((s) => s.selectFile)
  const file = node.file!
  const selected = file.path === selectedPath
  const glyph = STATUS_GLYPH[file.status] ?? STATUS_GLYPH.M!
  const dragPath = absolutePath(file.path, repoCwd)

  // 单击看内联 diff；双击在主预览打开——互斥：单击延迟 200ms 再选，让双击
  // 有机会取消（否则双击会同时触发两个预览）。
  const clickTimer = useRef<null | ReturnType<typeof setTimeout>>(null)

  useEffect(
    () => () => {
      if (clickTimer.current != null) clearTimeout(clickTimer.current)
    },
    [],
  )

  const handleClick = () => {
    if (clickTimer.current != null) clearTimeout(clickTimer.current)
    clickTimer.current = setTimeout(() => {
      clickTimer.current = null
      void selectFile(file)
    }, 200)
  }

  const openInPreview = () => {
    openFilePreview(dragPath, node.name)
  }

  const handleDoubleClick = () => {
    if (clickTimer.current != null) {
      clearTimeout(clickTimer.current)
      clickTimer.current = null
    }
    openInPreview()
  }

  return (
    <ReviewFileContextMenu dragPath={dragPath} file={file} onOpenChanges={() => void selectFile(file)} onOpenFile={openInPreview}>
      <div
        aria-selected={selected}
        className={cn(
          'row-hover flex h-6 select-none items-center gap-1.5 rounded-md pr-1.5 text-xs text-(--ui-text-secondary) hover:text-foreground',
          selected && 'bg-(--ui-row-active-background) text-foreground',
        )}
        draggable
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onDragStart={(event) => {
          event.dataTransfer.effectAllowed = 'copy'
          event.dataTransfer.setData(
            'application/x-mirach-paths',
            JSON.stringify([{ isDirectory: false, path: dragPath }]),
          )
          event.dataTransfer.setData('text/plain', dragPath)
        }}
        style={rowStyle(depth)}
        title={dragPath}
      >
        <Codicon className={cn('shrink-0', glyph.tone)} name={glyph.icon} size='0.8rem' />
        {/* Dir collapses first (huge shrink); the name only ellipsizes once the
            dir is gone — either way neither runs into the diff count. */}
        <span className='flex min-w-0 flex-1 items-baseline gap-1.5'>
          <span className='min-w-0 shrink truncate' title={node.name}>
            {node.name}
          </span>
          {node.dir && (
            <span className='min-w-0 shrink-[9999] truncate text-[0.68rem] text-(--ui-text-tertiary)' title={node.dir}>
              {node.dir}
            </span>
          )}
        </span>

        <span className='hidden shrink-0 items-center gap-0.5 group-hover/review-row:flex'>
          <StageRevertButtons file={file} />
        </span>

        <DiffCount added={node.added} className='text-[0.64rem] leading-4 group-hover/review-row:hidden' removed={node.removed} />
        {file.staged && (
          <span aria-hidden className='size-1.5 shrink-0 rounded-full bg-(--ui-green)/70' title='已暂存' />
        )}
      </div>
    </ReviewFileContextMenu>
  )
}

/** 行内悬停的两个动作：暂存/取消暂存、还原（破坏性，走确认框）。 */
function StageRevertButtons({ file }: { file: ReviewFile }) {
  const stageFile = useReview((s) => s.stageFile)
  const unstageFile = useReview((s) => s.unstageFile)
  const requestRevert = useReview((s) => s.requestRevert)

  return (
    <>
      <Tip label={file.staged ? '取消暂存' : '暂存'}>
        <Button
          aria-label={file.staged ? '取消暂存' : '暂存'}
          className='size-4 rounded text-muted-foreground/70 hover:text-foreground'
          onClick={(event) => {
            event.stopPropagation()
            void (file.staged ? unstageFile(file.path) : stageFile(file.path))
          }}
          size='icon-xs'
          variant='ghost'
        >
          <Codicon name={file.staged ? 'remove' : 'add'} size='0.7rem' />
        </Button>
      </Tip>
      <Tip label='还原'>
        <Button
          aria-label='还原'
          className='size-4 rounded text-muted-foreground/70 hover:text-(--ui-red)'
          onClick={(event) => {
            event.stopPropagation()
            requestRevert(file.path)
          }}
          size='icon-xs'
          variant='ghost'
        >
          <Codicon name='discard' size='0.7rem' />
        </Button>
      </Tip>
    </>
  )
}

/**
 * 变更文件的右键菜单（VS Code 的 SCM 菜单形状）：打开更改 / 打开文件、
 * 暂存·取消暂存、还原，然后复制路径。
 *
 * 上游还有「在文件树中定位」「在资源管理器/Finder 中显示」「复制相对路径」
 * 「远端下载」——宿主没有文件树定位通道（文件树是独立面板且未导出定位 API）、
 * 没有 shell 打开通道（fs_open_url 只放 http/https）、无远端模式 → 不渲染。
 */
function ReviewFileContextMenu({
  children,
  dragPath,
  file,
  onOpenChanges,
  onOpenFile,
}: {
  children: React.ReactElement<React.HTMLAttributes<HTMLElement> & { ref?: React.Ref<HTMLElement> }>
  dragPath: string
  file: ReviewFile
  onOpenChanges: () => void
  onOpenFile: () => void
}) {
  const stageFile = useReview((s) => s.stageFile)
  const unstageFile = useReview((s) => s.unstageFile)
  const requestRevert = useReview((s) => s.requestRevert)

  // 落点式（默认 anchor='point'）：右键落点弹菜单，**不接管左键**——行本身
  // 的左键是"看内联 diff"（上游 Radix ContextMenu 同语义；用 trigger 锚点
  // 会让左键开菜单，把单击选择抢掉）。
  return (
    <ContextMenu>
      <ContextMenuTrigger>{children}</ContextMenuTrigger>
      <ContextMenuContent ariaLabel='变更文件' className='w-56'>
        <ContextMenuItem onSelect={onOpenChanges}>打开更改</ContextMenuItem>
        <ContextMenuItem onSelect={onOpenFile}>打开文件</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() => {
            void (file.staged ? unstageFile(file.path) : stageFile(file.path))
          }}
        >
          {file.staged ? '取消暂存' : '暂存'}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => requestRevert(file.path)} tone='destructive'>
          还原
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void copyFilePath(dragPath)}>复制路径</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

/** 复制到剪贴板（失败可见，不静默）。 */
async function copyFilePath(path: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(path)
  } catch (e) {
    console.error('[review] 复制路径失败', e)
  }
}
