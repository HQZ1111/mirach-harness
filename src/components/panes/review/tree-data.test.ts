/**
 * 审查变更树的纯函数单测（hermes `review/tree-data.test.ts` 的对偶）。
 *
 * 锁三件事：
 * 1. 平铺列表按路径排序、dir 是父目录；
 * 2. 树模式聚合后代 +/-、单子链折叠（`a/b/c`）；
 * 3. 摊平只展开 open 的目录，且带正确深度。
 */

import { describe, expect, it } from 'vitest'

import type { ReviewFile } from '@/components/panes/review-store'

import { buildReviewFlatList, buildReviewTree, countAllNodes, flattenReviewRows } from './tree-data'

const file = (path: string, added = 1, removed = 0): ReviewFile => ({
  path,
  added,
  removed,
  status: 'M',
  staged: false,
})

describe('buildReviewFlatList', () => {
  it('sorts by path and keeps the parent dir separate', () => {
    const rows = buildReviewFlatList([file('src/b.ts'), file('README.md'), file('src/a.ts')])
    expect(rows.map((r) => r.id)).toEqual(['README.md', 'src/a.ts', 'src/b.ts'])
    expect(rows[0]).toMatchObject({ name: 'README.md', dir: '', isDir: false })
    expect(rows[1]).toMatchObject({ name: 'a.ts', dir: 'src', isDir: false })
  })

  it('carries per-file line counts', () => {
    const [row] = buildReviewFlatList([file('a.ts', 7, 3)])
    expect(row).toMatchObject({ added: 7, removed: 3 })
  })
})

describe('buildReviewTree', () => {
  it('aggregates descendant counts onto directories', () => {
    const tree = buildReviewTree([file('src/a.ts', 5, 1), file('src/deep/b.ts', 2, 3)])
    const src = tree.find((n) => n.isDir && n.name === 'src')
    expect(src).toBeDefined()
    expect(src!.added).toBe(7)
    expect(src!.removed).toBe(4)
  })

  it('compacts a single-child directory chain into one row', () => {
    const tree = buildReviewTree([file('a/b/c/d.ts')])
    // a/b/c 链折叠成一行（上游 compact 语义）
    expect(tree).toHaveLength(1)
    expect(tree[0]!.name).toBe('a/b/c')
    expect(tree[0]!.isDir).toBe(true)
  })

  it('keeps sibling dirs uncompacted and sorted', () => {
    const tree = buildReviewTree([file('z/x.ts'), file('a/x.ts')])
    expect(tree.map((n) => n.name)).toEqual(['a', 'z'])
  })

  it('leaves files at the root uncompacted', () => {
    const tree = buildReviewTree([file('README.md'), file('LICENSE')])
    expect(tree.every((n) => !n.isDir)).toBe(true)
    expect(tree.map((n) => n.name)).toEqual(['LICENSE', 'README.md'])
  })
})

describe('countAllNodes', () => {
  it('counts every descendant (heavy-list decision uses this)', () => {
    const tree = buildReviewTree([file('src/a.ts'), file('src/b.ts'), file('docs/c.md')])
    // src(1) + a,b(2) + docs(1) + c(1) = 5
    expect(countAllNodes(tree)).toBe(5)
  })
})

describe('flattenReviewRows', () => {
  it('emits only open directories’ children, with depth', () => {
    const tree = buildReviewTree([file('src/a.ts'), file('docs/b.md')])

    const closed = flattenReviewRows(tree, () => false)
    expect(closed.map((r) => r.node.name)).toEqual(['docs', 'src'])
    expect(closed.every((r) => r.depth === 0)).toBe(true)

    const open = flattenReviewRows(tree, () => true)
    expect(open.map((r) => `${r.depth}:${r.node.name}`)).toEqual(['0:docs', '1:b.md', '0:src', '1:a.ts'])
  })

  it('treats a leaf file as having no children', () => {
    const tree = buildReviewFlatList([file('a.ts')])
    const rows = flattenReviewRows(tree, () => true)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.depth).toBe(0)
  })
})
