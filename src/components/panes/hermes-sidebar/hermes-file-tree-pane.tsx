/**
 * hermes 文件树窗格 v2（用户 2026-09-29：文件要能打开；每类文件用颜色+
 * 图标区分）。视觉移植 app/right-sidebar/review/file-tree.tsx 形态；
 * 后端=本 harness fs_list/fs_read_data_url（≤16MB）。
 * 布局：[树 | 预览] 双栏——点文件就地打开，预览带头部（路径+关闭）。
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, FileText, Folder, FolderOpen, RefreshCw, X } from 'lucide-react'

import { fsList, fsReadDataUrl } from '@/lib/fs'
import { cn } from '@/lib/utils'

interface TreeNode {
  name: string
  path: string
  dir: boolean
}

// ── 文件类型区分（颜色+图标）：按扩展名族上色，代码族显示类型徽章 ──
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

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'])

function fileKindOf(name: string): FileKind | null {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  if (!ext) return null
  return FILE_KINDS.find((k) => k.exts.includes(ext))?.kind ?? null
}

/** 类型徽章：16px 圆角块，类型色底+字（代码族）；无族文件退回灰色文件图标。 */
function FileGlyph({ name }: { name: string }) {
  const kind = fileKindOf(name)
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

/** 展开目录的子节点缓存：path → children。 */
export function HermesFileTreePane() {
  const [root, setRoot] = useState('G:/mirach-harness')
  const [draft, setDraft] = useState(root)
  const [nodes, setNodes] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [openDirs, setOpenDirs] = useState<Record<string, TreeNode[]>>({})
  // 预览态：path + 解码后的内容/图片 dataUrl
  const [preview, setPreview] = useState<{ path: string; name: string; text?: string; image?: string; binary?: boolean } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)

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
        setPreview(null)
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

  const openFile = async (node: TreeNode) => {
    setSelected(node.path)
    setPreviewLoading(true)
    setPreview({ path: node.path, name: node.name })
    try {
      const dataUrl = await fsReadDataUrl(node.path)
      const ext = node.name.includes('.') ? node.name.split('.').pop()!.toLowerCase() : ''
      if (IMAGE_EXTS.has(ext)) {
        setPreview({ path: node.path, name: node.name, image: dataUrl })
      } else {
        const res = await fetch(dataUrl)
        const text = await res.text()
        const binary = text.includes('\u0000')
        setPreview({ path: node.path, name: node.name, binary, text: binary ? undefined : text })
      }
    } catch {
      setPreview({ path: node.path, name: node.name, binary: true })
    } finally {
      setPreviewLoading(false)
    }
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
                await openFile(n)
              }
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
              <FileGlyph name={n.name} />
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

  const tree = (
    <div className="flex h-full min-h-0 flex-col bg-(--surface)">
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

  const previewPanel = preview ? (
    <div className="flex h-full min-w-0 flex-1 flex-col border-l border-(--stroke-soft) bg-(--surface)">
      <div className="flex items-center gap-2 border-b border-(--stroke-soft) px-2 py-1.5">
        <FileGlyph name={preview.name} />
        <span className="min-w-0 flex-1 truncate text-xs text-(--text-2)" title={preview.path}>
          {preview.path}
        </span>
        <button
          aria-label="关闭预览"
          className="grid size-5 shrink-0 place-items-center rounded text-(--text-3) hover:bg-(--hover-wash) hover:text-(--text)"
          onClick={() => setPreview(null)}
          type="button"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {previewLoading ? (
          <div className="p-3 text-xs text-(--text-4)">加载中…</div>
        ) : preview.image ? (
          <img alt={preview.name} className="max-w-full" src={preview.image} />
        ) : preview.binary ? (
          <div className="p-3 text-xs text-(--text-4)">二进制文件，不支持预览</div>
        ) : (
          <pre className="p-3 font-mono text-[0.75rem] leading-5 whitespace-pre-wrap break-all text-(--text-2)">
            {preview.text}
          </pre>
        )}
      </div>
    </div>
  ) : null

  return (
    <div className="flex h-full min-h-0">
      <div
        className={cn(
          'h-full min-h-0',
          preview ? 'w-[55%] shrink-0 border-r border-(--stroke-soft)' : 'w-full',
        )}
      >
        {tree}
      </div>
      {previewPanel}
    </div>
  )
}
