/**
 * 工具呈现层单测（openhuman toolPresentation 移植的 pi 适配版）：
 * 解析顺序（action → exact → family → fallback）、chip 清洗、中文短语。
 */
import { describe, expect, it } from 'vitest'

import { describeToolCall, toolLabelZh } from './tool-presentation'
import { chip, displayUrl, shortenPath, truncateChip } from './tool-chips'

describe('chip helpers（openhuman 原样拷入）', () => {
  it('truncateChip 折叠空白并截断', () => {
    expect(truncateChip('  a   b  ')).toBe('a b')
    expect(truncateChip('x'.repeat(100), 10)).toBe('xxxxxxxxx…')
  })

  it('shortenPath 保留最后两段', () => {
    expect(shortenPath('/a/b/c/d.ts')).toBe('…/c/d.ts')
    expect(shortenPath('a/b.ts')).toBe('a/b.ts')
  })

  it('displayUrl 去协议、保留 host+path', () => {
    expect(displayUrl('https://docs.rs/tokio/latest/x')).toBe('docs.rs/tokio/latest/x')
    expect(displayUrl('not a url')).toBe('not a url')
  })

  it('chip.path 取 path/file_path', () => {
    expect(chip.path()({ path: '/a/b/c/d.ts' })).toBe('…/c/d.ts')
    expect(chip.path()({})).toBeUndefined()
  })

  it('chip.query 取 query/q/search_query/objective', () => {
    expect(chip.query()({ q: 'rust traits' })).toBe('rust traits')
    expect(chip.query()({})).toBeUndefined()
  })
})

describe('describeToolCall（pi 工具表）', () => {
  it('精确命中：read → 读取文件 + 路径 chip', () => {
    const p = describeToolCall({ name: 'read', args: { path: '/a/b/c.ts' } })
    expect(p.source).toBe('exact')
    expect(p.category).toBe('file')
    expect(p.phrase).toBe('readFile')
    expect(p.chip).toBe('…/b/c.ts')
    expect(p.body).toBe('file')
  })

  it('edit/hashline_edit → diff 体', () => {
    expect(describeToolCall({ name: 'edit', args: { path: 'x' } }).body).toBe('diff')
    expect(describeToolCall({ name: 'hashline_edit', args: { path: 'x' } }).body).toBe('diff')
  })

  it('bash → terminal 体 + 命令 chip（120 上限）', () => {
    const p = describeToolCall({ name: 'bash', args: { command: 'npm test' } })
    expect(p.body).toBe('terminal')
    expect(p.chip).toBe('npm test')
  })

  it('action 分叉优先：hub:agent', () => {
    const p = describeToolCall({ name: 'hub', args: { action: 'agent' } })
    expect(p.source).toBe('action')
    expect(p.phrase).toBe('runAgent')
  })

  it('action 未命中回落 exact：hub{action:"roster"}', () => {
    const p = describeToolCall({ name: 'hub', args: { action: 'roster' } })
    expect(p.source).toBe('exact')
    expect(p.phrase).toBe('useHub')
  })

  it('family 前缀：未知 ast_ 成员', () => {
    const p = describeToolCall({ name: 'ast_custom', args: {} })
    expect(p.source).toBe('family')
  })

  it('兜底：未知工具 → 扳手 + "Using X"，绝不裸 snake_case', () => {
    const p = describeToolCall({ name: 'my_custom_tool', args: { foo: 1 } })
    expect(p.source).toBe('fallback')
    expect(p.label).toBe('Using My custom tool')
    expect(p.label.includes('_')).toBe(false)
  })

  it('status 决定时态', () => {
    expect(describeToolCall({ name: 'read', status: 'running' }).label).toBe('Reading file')
    expect(describeToolCall({ name: 'read', status: 'success' }).label).toBe('Read file')
    expect(describeToolCall({ name: 'read', status: 'error' }).label).toBe('Read file')
  })
})

describe('toolLabelZh', () => {
  it('已知短语 → 中文；运行中加「正在」', () => {
    expect(toolLabelZh('readFile', false)).toBe('读取文件')
    expect(toolLabelZh('readFile', true)).toBe('正在读取文件')
  })
  it('未知短语回落英文原表', () => {
    expect(toolLabelZh('deploySite', false)).toBe('Deployed site')
  })
})
