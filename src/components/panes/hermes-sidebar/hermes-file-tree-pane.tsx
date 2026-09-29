/**
 * hermes 文件树窗格（视觉移植：app/right-sidebar/review/file-tree.tsx 的
 * chevron+缩进+行形态；后端用本 harness 的 fs_list——与 hermes 的
 * useProjectTree(ipc readProjectDir) 同构，纯 UI 不接她的 store）。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, FileText, Folder, FolderOpen, RefreshCw } from 'lucide-react'

import { fsList } from '@/lib/fs'
import { cn } from '@/lib/utils'

interface TreeNode {
  name: string
  path: string
  dir: boolean
}

/** 展开目录的子节点缓存：path → children。 */
export function HermesFileTreePane() {
  const [root, setRoot] = useState('G:/mirach-harness')
  const [draft, setDraft] = useState(root)
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
              setSelected(n.path)
              if (n.dir) await toggleDir(n)
            }}
            style={{ paddingLeft: 8 + depth * 14 }}
            type="button"
          >
            {n.dir ? (
              <ChevronRight
                className={cn('size-3.5 shrink-0 text-(--text-3) transition', open && 'rotate-90')}
              />
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
              <FileText className="size-3.5 shrink-0 text-(--text-3)" />
            )}
            <span
              className={cn(
                'truncate text-[0.8125rem] leading-5',
                isSel ? 'text-(--text)' : 'text-(--text-2)',
              )}
            >
              {n.name}
            </span>
          </button>
          {n.dir && open && openDirs[n.path] && (
            <div>{renderRows(openDirs[n.path], depth + 1)}</div>
          )}
        </div>
      )
    })

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--surface)">
      {/* 路径行 + 刷新（hermes 文件浏览头部形态） */}
      <div className="flex items-center gap-1.5 px-2 pt-2 pb-1">
        <input
          className="h-7 min-w-0 flex-1 rounded-md border border-(--stroke-soft) bg-transparent px-2 text-xs text-(--text) outline-none"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && draft.trim()) setRoot(draft.trim())
          }}
          value={draft}
        />
        <button
          aria-label="刷新"
          className={cn(
            'grid size-7 shrink-0 place-items-center rounded-md text-(--text-3)',
            'hover:bg-(--hover-wash) hover:text-(--text)',
          )}
          onClick={() => void loadRoot(draft.trim() || root)}
          title="刷新"
          type="button"
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
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
