/**
 * 审查变更文件的树/列表数据 —— hermes 桌面端
 * `app/right-sidebar/review/tree-data.ts`（173 行）的逐字移植。
 *
 * 树节点聚合后代 +/-（折叠的文件夹仍显示总变更量，Codex 的层级视图）；
 * 平铺列表是 VS Code 默认的 SCM「列表」视图（文件名 + 暗色父目录）。
 */

import type { ReviewFile } from '@/components/panes/review-store'

export interface ReviewTreeNode {
  id: string
  name: string
  isDir: boolean
  added: number
  removed: number
  /** For a flat-list file row: the parent dir (relative), shown dimmed. */
  dir?: string
  file?: ReviewFile
  children?: ReviewTreeNode[]
}

/** 平铺变更列表（按路径排序，无文件夹节点）。 */
export function buildReviewFlatList(files: ReviewFile[]): ReviewTreeNode[] {
  return [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => {
      const segments = file.path.split('/').filter(Boolean)
      const name = segments.pop() ?? file.path

      return {
        id: file.path,
        name,
        dir: segments.join('/'),
        isDir: false,
        added: file.added,
        removed: file.removed,
        file,
      }
    })
}

interface MutableDir {
  id: string
  name: string
  added: number
  removed: number
  dirs: Map<string, MutableDir>
  files: ReviewTreeNode[]
}

const makeDir = (id: string, name: string): MutableDir => ({
  id,
  name,
  added: 0,
  removed: 0,
  dirs: new Map(),
  files: [],
})

/**
 * 从平铺列表建文件夹层级。`compact` 时单子目录链折叠成一行（`a/b/c`），
 * 与 VS Code / Codex 渲染稀疏树的方式一致。
 */
export function buildReviewTree(files: ReviewFile[], compact = true): ReviewTreeNode[] {
  const root = makeDir('', '')

  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean)
    const fileName = segments.pop() ?? file.path
    let dir = root

    dir.added += file.added
    dir.removed += file.removed

    let prefix = ''

    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment
      let child = dir.dirs.get(segment)

      if (!child) {
        child = makeDir(prefix, segment)
        dir.dirs.set(segment, child)
      }

      child.added += file.added
      child.removed += file.removed
      dir = child
    }

    dir.files.push({
      id: file.path,
      name: fileName,
      isDir: false,
      added: file.added,
      removed: file.removed,
      file,
    })
  }

  const finalize = (dir: MutableDir): ReviewTreeNode[] => {
    const dirNodes: ReviewTreeNode[] = [...dir.dirs.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((child) => {
        let node: ReviewTreeNode = {
          id: child.id,
          name: child.name,
          isDir: true,
          added: child.added,
          removed: child.removed,
          children: finalize(child),
        }

        // Compact a chain: a folder whose only child is one folder merges into
        // `parent/child` so deep sparse paths read on one row.
        while (compact && node.children?.length === 1 && node.children[0].isDir) {
          const only = node.children[0]
          node = { ...only, name: `${node.name}/${only.name}` }
        }

        return node
      })

    const fileNodes = [...dir.files].sort((a, b) => a.name.localeCompare(b.name))

    return [...dirNodes, ...fileNodes]
  }

  return finalize(root)
}

/** 虚拟化列表的一行：节点 + 渲染缩进深度。 */
export interface ReviewFlatRow {
  node: ReviewTreeNode
  depth: number
}

/**
 * 含全部后代的总节点数——判断是否需要虚拟化的廉价上界。一个装几万个
 * 未跟踪文件的文件夹只有一个顶层节点，但仍必须算「重」。
 */
export function countAllNodes(nodes: ReviewTreeNode[]): number {
  let total = 0

  for (const node of nodes) {
    total += 1

    if (node.children) {
      total += countAllNodes(node.children)
    }
  }

  return total
}

/**
 * 把树摊平成「当前可见」的行：目录只在展开时贡献子行（`isOpen` 收节点 id），
 * 每行带缩进深度。虚拟化滚动器只挂这批行。
 */
export function flattenReviewRows(
  nodes: ReviewTreeNode[],
  isOpen: (id: string) => boolean,
  depth = 0,
  rows: ReviewFlatRow[] = [],
): ReviewFlatRow[] {
  for (const node of nodes) {
    rows.push({ depth, node })

    if (node.isDir && node.children && isOpen(node.id)) {
      flattenReviewRows(node.children, isOpen, depth + 1, rows)
    }
  }

  return rows
}
