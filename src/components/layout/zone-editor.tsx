/**
 * Zone 编辑器 —— hermes「New grid layout」（$zoneEditorOpen）的移植：
 * 从零画一棵分叉树，把窗格分配进组，应用后生成新布局。
 * 树结构直接用 flexlayout JSON 形状（row/tabset），行方向按深度交替
 * （深度偶数=横排）；权重建出来先均分，应用后可拖分隔条微调。
 */

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import { GLOBAL_ATTRS, makeBordersJson } from './layout-presets'
import { PANE_TYPES, paneTabJson, type PaneType } from './pane-registry'

// v2.1：窗格清单从类型注册表派生（编辑器按类型放置，单例 id = 类型名；
// 多实例类型以基础实例出现，应用后可经 zone「+」增开更多实例）。
const PANES: { id: string; name: string; closeable: boolean }[] = (
  Object.keys(PANE_TYPES) as PaneType[]
).map((t) => ({ id: t, name: PANE_TYPES[t].name, closeable: !PANE_TYPES[t].primary }))

// ── 编辑树（split/group，转成 flexlayout JSON） ──────────────────────────────

interface ZESplit {
  kind: 'split'
  children: ZENode[]
}
interface ZEGroup {
  kind: 'group'
  panes: string[]
}
type ZENode = ZESplit | ZEGroup

const emptyGroup = (): ZEGroup => ({ kind: 'group', panes: [] })

// 不可变按路径变换：path = 子索引序列
const transform = (node: ZENode, path: number[], fn: (n: ZENode) => ZENode): ZENode => {
  if (path.length === 0) return fn(node)
  if (node.kind !== 'split') return node
  const [head, ...rest] = path
  return {
    ...node,
    children: node.children.map((c, i) => (i === head ? transform(c, rest, fn) : c)),
  }
}

const collectPanes = (node: ZENode, out: string[] = []): string[] => {
  if (node.kind === 'group') out.push(...node.panes)
  else node.children.forEach((c) => collectPanes(c, out))
  return out
}

// 折叠单子 split：父 split 只剩一个子时用子顶替（向上冒泡）
const normalize = (node: ZENode): ZENode => {
  if (node.kind === 'group') return node
  const children = node.children.map(normalize)
  if (children.length === 0) return emptyGroup()
  if (children.length === 1) return children[0]
  return { ...node, children }
}

// 从父 split 里删掉 path 处的孩子，再 normalize（父只剩一子时用子顶替）
const removeAtPath = (node: ZENode, path: number[]): ZENode => {
  const parentPath = path.slice(0, -1)
  const idx = path[path.length - 1]
  const parent = getAt(node, parentPath)
  if (!parent || parent.kind !== 'split') return node
  const nextParent: ZESplit = { ...parent, children: parent.children.filter((_, i) => i !== idx) }
  return normalize(transform(node, parentPath, () => nextParent))
}

const getAt = (node: ZENode, path: number[]): ZENode | undefined => {
  let cur: ZENode = node
  for (const i of path) {
    if (cur.kind !== 'split') return undefined
    cur = cur.children[i]
    if (!cur) return undefined
  }
  return cur
}

// 编辑树 → flexlayout JSON（权重均分，flexlayout 会归一化）
const toJson = (node: ZENode): any => {
  if (node.kind === 'group') {
    return {
      type: 'tabset',
      weight: 100,
      selected: 0,
      children: node.panes.map((id) => paneTabJson(id)),
    }
  }
  return { type: 'row', weight: 100, children: node.children.map((c) => toJson(c)) }
}

// ── 组件 ─────────────────────────────────────────────────────────────────────

export function ZoneEditor({ onApply, onClose }: { onApply: (json: unknown) => void; onClose: () => void }) {
  const [tree, setTree] = useState<ZENode>(() => ({ kind: 'split', children: [emptyGroup(), emptyGroup()] }))

  const placed = useMemo(() => collectPanes(tree), [tree])
  const unplaced = PANES.map((p) => p.id).filter((id) => !placed.includes(id))
  const duplicated = placed.filter((id, i) => placed.indexOf(id) !== i)
  const ready = unplaced.length === 0 && duplicated.length === 0

  // 所有变更走这里：normalize 后根必须仍是 split（渲染约定）
  const update = (fn: (t: ZENode) => ZENode) =>
    setTree((t) => {
      const n = fn(t)
      return n.kind === 'split' ? n : { kind: 'split', children: [n] }
    })

  const nameOf = (id: string) => PANES.find((p) => p.id === id)?.name ?? id

  const renderGroup = (group: ZEGroup, path: number[]) => (
    <div className="ze-group">
      {group.panes.length === 0 && <div className="ze-empty">空组 · 从下面加窗格</div>}
      {group.panes.map((id) => (
        <span className="ze-chip" key={id}>
          {nameOf(id)}
          <button
            className="ze-chip-x"
            onClick={() =>
              update((t) =>
                transform(t, path, (n) =>
                  n.kind === 'group' ? { ...n, panes: n.panes.filter((p) => p !== id) } : n,
                ),
              )
            }
            type="button"
          >
            ×
          </button>
        </span>
      ))}
      <div className="ze-add">
        <select
          className="ze-select"
          value=""
          onChange={(e) => {
            const id = e.target.value
            if (!id) return
            update((t) => transform(t, path, (n) => (n.kind === 'group' ? { ...n, panes: [...n.panes, id] } : n)))
          }}
        >
          <option value="">+ 加窗格…</option>
          {PANES.filter((p) => !placed.includes(p.id) || group.panes.includes(p.id)).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  )

  const renderSplit = (split: ZESplit, path: number[], depth: number) => {
    const children = split.children.map((child, i) => (
      <div className="ze-cell" key={i}>
        {child.kind === 'split' ? renderSplit(child, [...path, i], depth + 1) : renderGroup(child, [...path, i])}
      </div>
    ))
    const actions = (
      <div className="ze-cell ze-cell-actions">
        <button
          className="ze-mini"
          onClick={() => update((t) => transform(t, path, (n) => (n.kind === 'split' ? { ...n, children: [...n.children, emptyGroup()] } : n)))}
          type="button"
        >
          + 拆分
        </button>
        {path.length > 0 && (
          <button className="ze-mini" onClick={() => update((t) => removeAtPath(t, path))} type="button">
            删除此组
          </button>
        )}
      </div>
    )
    return <div className={`ze-split ${depth % 2 === 0 ? 'ze-horz' : 'ze-vert'}`}>{[...children, actions]}</div>
  }

  // portal 到 body（根上下文）：.flexlayout-host 是 isolation:isolate——
  // 宿主内再高的 z 也压不过根上下文的 .app-titlebar(50)，遮罩挂宿主内时
  // 窗口圆点/工具钮浮在暗色 scrim 上（审查 D-2）。
  return createPortal(
    <div className="ze-backdrop" onPointerDown={(e) => e.stopPropagation()}>
      <div className="ze-card">
        <header className="ze-header">
          <h2 className="text-sm font-semibold">新建网格布局</h2>
          <button className="app-titlebar-btn" onClick={onClose} type="button">
            取消
          </button>
        </header>
        <p className="ze-hint">
          最外层横排、嵌套自动变竖排、再嵌套又横排。每组放一个或多个窗格（同组并排成页签）。
          {unplaced.length > 0 && <span className="ze-warn"> 还有 {unplaced.length} 个窗格未放置：{unplaced.map(nameOf).join('、')}。</span>}
          {duplicated.length > 0 && <span className="ze-warn"> 有窗格被重复放置。</span>}
        </p>
        <div className="ze-canvas">
          {renderSplit(
            tree.kind === 'split' ? tree : { kind: 'split', children: [tree] },
            [],
            0,
          )}
        </div>
        <footer className="ze-footer">
          <button
            className="app-titlebar-btn ze-apply"
            disabled={!ready}
            onClick={() => {
              onApply({ global: GLOBAL_ATTRS, borders: makeBordersJson(), layout: toJson(tree) })
              onClose()
            }}
            type="button"
          >
            应用布局
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}