/**
 * hermes 文件树窗格 v3（用户 2026-09-29：地址纯显示+左文件夹钮选位置
 * （Tauri dialog）+刷新旁折叠全部钮；点文件=右侧栏开预览标签）。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronsDownUp, ChevronRight, FileText, Folder, FolderOpen, FolderSearch, RefreshCw } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'

import { fsList } from '@/lib/fs'
import { openFilePreview } from './preview-opener'
import { cn } from '@/lib/utils'

interface TreeNode {
  name: string
  path: string
  dir: boolean
}

// ── 类型徽章（与预览组件同表） ──
interface FileKind {
  label: string
  color: string
  bg: string
}
const FILE_KINDS: Array<{ exts: string[]; kind: FileKind }> = [
  { exts: ['ts', 'tsx'], kind: { label: 'TS', color: '#3178c6', bg: 'rgba(49,120,198,0.15)' } },
  { exts: ['js', 'jsx', 'mjs', 'cjs'], kind: { label: 'JS', color: '#b7791f', bg: 'rgba(183,121,31,0.15)' } },
  { exts: ['json'], kind: { label: '{}', color: '#8a8a00', bg: 'rgba(138,138,0,0.14)' } },
  { exts: ['css'], kind: { label: 'CSS', color: '#0ea5e9', bg: 'rgba(14,165,233,0.15)' } },
  { exts: ['html', 'htm'], kind: { label: '<>', color: '#e06c35', bg: 'rgba(224,108,53,0.15)' } },
  { exts: ['md'], kind: { label: 'MD', color: '#5b6bd6', bg: 'rgba(91,107,214,0.15)' } },
  { exts: ['rs'], kind: { label: 'RS', color: '#c2410c', bg: 'rgba(194,65,12,0.15)' } },
  { exts: ['toml', 'yaml', 'yml', 'ini', 'conf'], kind: { label: 'CFG', color: '#64748b', bg: 'rgba(100,116,139,0.15)' } },
  { exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'], kind: { label: 'IMG', color: '#9333ea', bg: 'rgba(147,51,234,0.15)' } },
  { exts: ['lock'], kind: { label: 'LCK', color: '#52525b', bg: 'rgba(82,82,91,0.15)' } },
]
function FileGlyph({ name }: { name: string }) {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const kind = ext ? FILE_KINDS.find((k) => k.exts.includes(ext))?.kind : undefined
  if (!kind) return <FileText className="size-3.5 shrink-0 text-(--text-3)" />
  return (
    <span
      className="grid h-4 w-5 shrink-0 place-items-center rounded-[3px] text-[0.5rem] font-bold leading-none"
      style={{ background: kind.bg, color: kind.color }}
    >
      {kind.label}
    </span>
  )
}

export function HermesFileTreePane() {
  const [root, setRoot] = useState('G:/mirach-harness')
  const [nodes, setNodes] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [openDirs, setOpenDirs] = useState<Record<string, TreeNode[]>>({})

  const fetchChildren = useCallback(async (dir: string): Promise<TreeNode[]> => {
    const result = await fsList(dir)
    return (result.entries ?? []).map((e) => ({
      name: e.name,
      path: dir ? dir + '/' + e.name : e.name,
      dir: e.isDirectory,
    }))
  }, [])

  const loadRoot = useCallback(
    async (dir: string) => {
      setLoading(true)
      try {
        setNodes(await fetchChildren(dir))
        setOpenDirs({})
        setSelected(null)
      } finally {
        setLoading(false)
      }
    },
    [fetchChildren],
  )

  useEffect(() => {
    void loadRoot(root)
  }, [root, loadRoot])

  const toggleDir = async (node: TreeNode) => {
    if (openDirs[node.path]) {
      setOpenDirs((m) => {
        const next = { ...m }
        delete next[node.path]
        return next
      })
      return
    }
    const kids = await fetchChildren(node.path)
    setOpenDirs((m) => ({ ...m, [node.path]: kids }))
  }

  const pickFolder = async () => {
    const dir = await open({ directory: true })
    if (typeof dir === 'string' && dir) setRoot(dir)
  }

  const renderRows = (list: TreeNode[], depth: number): ReactNode =>
    list.map((n) => {
      const open = !!openDirs[n.path]
      const isSel = selected === n.path
      return (
        <div key={n.path}>
          <button
            className={cn(
              'group/ft flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left',
              isSel ? 'bg-[color-mix(in_srgb,var(--fl-accent)_10%,transparent)]' : 'hover:bg-(--hover-wash)',
            )}
            onClick={async () => {
              if (n.dir) {
                setSelected(n.path)
                await toggleDir(n)
              } else {
                setSelected(n.path)
                openFilePreview(n.path, n.name)
              }
            }}
            style={{ paddingLeft: 8 + depth * 14 }}
            type="button"
          >
            {n.dir ? (
              <ChevronRight className={cn('size-3.5 shrink-0 text-(--text-3) transition', open && 'rotate-90')} />
            ) : (
              <span className="size-3.5 shrink-0" />
            )}
            {n.dir ? (
              open ? (
                <FolderOpen className="size-3.5 shrink-0 text-(--fl-accent)" />
              ) : (
                <Folder className="size-3.5 shrink-0 text-(--fl-accent)" />
              )
            ) : (
              <FileGlyph name={n.name} />
            )}
            <span className={cn('truncate text-[0.8125rem] leading-5', isSel ? 'text-(--text)' : 'text-(--text-2)')}>
              {n.name}
            </span>
          </button>
          {n.dir && open && openDirs[n.path] && <div>{renderRows(openDirs[n.path], depth + 1)}</div>}
        </div>
      )
    })

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--surface)">
      {/* 地址行：纯显示 + 左侧文件夹钮选位置 + 刷新 + 折叠全部 */}
      <div className="flex items-center gap-1 px-2 pt-2 pb-1">
        <button
          aria-label="选择文件夹"
          className="grid size-6 shrink-0 place-items-center rounded-md text-(--fl-accent) hover:bg-(--hover-wash)"
          onClick={() => void pickFolder()}
          title="选择文件夹"
          type="button"
        >
          <FolderSearch className="size-4" />
        </button>
        <span className="min-w-0 flex-1 truncate text-xs text-(--text-2)" title={root}>
          {root}
        </span>
        <button
          aria-label="折叠全部"
          className="grid size-6 shrink-0 place-items-center rounded-md text-(--text-3) hover:bg-(--hover-wash) hover:text-(--text)"
          onClick={() => setOpenDirs({})}
          title="折叠全部文件夹"
          type="button"
        >
          <ChevronsDownUp className="size-4" />
        </button>
        <button
          aria-label="刷新"
          className={cn(
            'grid size-6 shrink-0 place-items-center rounded-md text-(--text-3)',
            'hover:bg-(--hover-wash) hover:text-(--text)',
          )}
          onClick={() => void loadRoot(root)}
          title="刷新"
          type="button"
        >
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {renderRows(nodes, 0)}
        {!loading && nodes.length === 0 && (
          <div className="px-3 py-6 text-center text-xs text-(--text-4)">目录为空</div>
        )}
      </div>
    </div>
  )
}
