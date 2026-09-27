/**
 * 文件树窗格（右栏 files）：基于 src-tauri fs_list 的懒加载目录树。
 * 根路径可输入（回车/「转到」切换）；目录点击展开/收起（按需 fsList）；
 * 文件为叶子（点击仅选中，预览待接 fs_read_data_url）。
 * 纯浏览器直开（无 Tauri）显示提示。
 */
import { useCallback, useEffect, useState } from 'react'

import { fsList, type FsEntry } from '@/lib/fs'
import { inTauri } from '@/lib/tauri-window'

const DEFAULT_ROOT = 'G:/mirach-harness'

interface TreeNodeProps {
  entry: FsEntry
  depth: number
  selectedPath: string | null
  onSelect: (path: string, isDirectory: boolean) => void
}

function TreeNode({ entry, depth, selectedPath, onSelect }: TreeNodeProps) {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<FsEntry[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = useCallback(async () => {
    if (!entry.isDirectory) return
    if (expanded) {
      setExpanded(false)
      return
    }
    if (children === null && !loading) {
      setLoading(true)
      try {
        const res = await fsList(entry.path)
        setChildren(res.entries)
        setError(res.error ?? null)
      } catch {
        setError('read-error')
      } finally {
        setLoading(false)
      }
    }
    setExpanded(true)
  }, [entry, expanded, children, loading])

  const selected = selectedPath === entry.path

  return (
    <div>
      <div
        className={`ft-row${selected ? ' ft-row-selected' : ''}`}
        style={{ paddingLeft: depth * 14 + 6 }}
        onClick={() => {
          onSelect(entry.path, entry.isDirectory)
          void toggle()
        }}
      >
        <span className="ft-caret">{entry.isDirectory ? (expanded ? '▾' : '▸') : '·'}</span>
        <span className="ft-name">{entry.name}</span>
      </div>
      {expanded && loading && <div className="ft-empty">加载中…</div>}
      {expanded && error && <div className="ft-error">{error}</div>}
      {expanded && children !== null &&
        children.map((c) => (
          <TreeNode
            key={c.path}
            entry={c}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      {expanded && children !== null && children.length === 0 && !error && (
        <div className="ft-empty">（空）</div>
      )}
    </div>
  )
}

export function FileTreePane() {
  const [root, setRoot] = useState(DEFAULT_ROOT)
  const [draft, setDraft] = useState(DEFAULT_ROOT)
  const [entries, setEntries] = useState<FsEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)

  useEffect(() => {
    if (!inTauri) return
    let alive = true
    fsList(root)
      .then((res) => {
        if (!alive) return
        setEntries(res.entries)
        setError(res.error ?? null)
      })
      .catch(() => alive && setError('read-error'))
    return () => {
      alive = false
    }
  }, [root])

  if (!inTauri) {
    return (
      <div className="pane-placeholder">
        <h2>文件树</h2>
        <p>需要 Tauri 环境（fs 命令）。</p>
      </div>
    )
  }

  return (
    <div className="file-tree-pane">
      <form
        className="ft-root-bar"
        onSubmit={(e) => {
          e.preventDefault()
          setRoot(draft)
          setSelectedPath(null)
        }}
      >
        <input
          className="ft-root-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
        />
        <button type="submit" className="ft-root-go">
          转到
        </button>
      </form>
      {error && <div className="ft-error">读取失败（{error}）</div>}
      {entries !== null && (
        <div className="ft-tree">
          {entries.length === 0 && <div className="ft-empty">（空目录）</div>}
          {entries.map((e) => (
            <TreeNode
              key={e.path}
              entry={e}
              depth={0}
              selectedPath={selectedPath}
              onSelect={(p) => setSelectedPath(p)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
