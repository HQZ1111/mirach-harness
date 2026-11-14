import { describe, expect, it } from 'vitest'
import {
  buildFamilySummary,
  classifyToolFamily,
  extractToolCommands,
  isChangesToolCall,
  isExecuteToolCall,
  isExploreToolCall,
} from './tool-grouping'

describe('extractToolCommands（照抄 ZCode 的命令提取）', () => {
  it('直接取 command，按 && / || / ; 切段', () => {
    expect(extractToolCommands({ command: 'ls -la && cat a.txt' })).toEqual([
      'ls -la',
      'cat a.txt',
    ])
  })

  it('剥掉 bash -lc / powershell -Command 外壳', () => {
    expect(extractToolCommands({ command: 'bash -lc "rg foo"' })).toEqual(['rg foo'])
    expect(extractToolCommands({ command: 'pwsh -Command "Get-ChildItem"' })).toEqual([
      'Get-ChildItem',
    ])
  })

  it('数组形态里 -lc 后那一段才是真命令', () => {
    expect(extractToolCommands({ command: ['/bin/bash', '-lc', 'rg x'] })).toEqual(['rg x'])
  })
})

describe('isExploreToolCall / isExecuteToolCall（只读 vs 非只读）', () => {
  it('读文件与搜索恒为查阅', () => {
    expect(isExploreToolCall('read', { path: '/a.ts' })).toBe(true)
    expect(isExploreToolCall('grep', { pattern: 'x' })).toBe(true)
    expect(isExploreToolCall('find', { pattern: '*.ts' })).toBe(true)
    expect(isExploreToolCall('web_search', { query: 'x' })).toBe(true)
  })

  it('写文件不是查阅', () => {
    expect(isExploreToolCall('edit', { path: '/a.ts' })).toBe(false)
    expect(isExploreToolCall('write', { path: '/a.ts' })).toBe(false)
  })

  it('只读 shell 归查阅，写入 shell 归终端', () => {
    expect(isExploreToolCall('bash', { command: 'rg foo src' })).toBe(true)
    expect(isExploreToolCall('bash', { command: 'git status' })).toBe(true)
    expect(isExecuteToolCall('bash', { command: 'rg foo src' })).toBe(false)
    expect(isExecuteToolCall('bash', { command: 'npm test' })).toBe(true)
    expect(isExecuteToolCall('bash', { command: 'rm -rf dist' })).toBe(true)
  })

  it('重定向写入不算只读', () => {
    expect(isExploreToolCall('bash', { command: 'ls > out.txt' })).toBe(false)
  })

  it('没有命令的 shell 既不是查阅也不是终端（尚未分类）', () => {
    expect(isExploreToolCall('bash', {})).toBe(false)
    expect(isExecuteToolCall('bash', {})).toBe(false)
    expect(classifyToolFamily('bash', {})).toBe('other')
  })
})

describe('classifyToolFamily', () => {
  it('三族与 other 的归类', () => {
    expect(classifyToolFamily('read', {})).toBe('explore')
    expect(classifyToolFamily('bash', { command: 'npm run build' })).toBe('execute')
    expect(classifyToolFamily('edit', {})).toBe('changes')
    expect(classifyToolFamily('todo', {})).toBe('other')
  })

  it('写文件族覆盖 pi 的四个写工具', () => {
    for (const name of ['write', 'edit', 'hashline_edit', 'ast_edit']) {
      expect(isChangesToolCall(name)).toBe(true)
    }
    expect(isChangesToolCall('read')).toBe(false)
  })
})

// toolAwareGroupPath / shouldCollapseSingleChildGroup 已随 GroupedParts 替换
// 删除（2026-11-07）：分组语义改由 assistant-work-items.ts 的扫描承担，
// 其单测在 assistant-work-items.test.ts（含"单子项摊平"与"跨隐藏思考合族"）。

describe('buildFamilySummary（父组摘要契约）', () => {
  const tool = (toolName: string, args: unknown, statusType = 'complete') => ({
    toolName,
    args,
    statusType,
  })

  it('终端运行中显示最新命令', () => {
    const s = buildFamilySummary(
      'execute',
      [tool('bash', { command: 'npm i' }), tool('bash', { command: 'npm test' }, 'running')],
      true,
    )
    expect(s.text).toBe('运行命令 npm test')
  })

  it('终端完成显示命令数与失败数', () => {
    expect(buildFamilySummary('execute', [tool('bash', { command: 'a' })], false).text).toBe(
      '1 个命令',
    )
    expect(
      buildFamilySummary(
        'execute',
        [tool('bash', { command: 'a' }), tool('bash', { command: 'b' }, 'incomplete')],
        false,
      ).text,
    ).toBe('2 个命令，1 个失败')
  })

  it('终端：子项失败不把父级标成失败（文本里只有计数）', () => {
    const s = buildFamilySummary('execute', [tool('bash', { command: 'a' }, 'incomplete')], false)
    expect(s.text).not.toContain('失败状态')
    expect(s.text).toBe('1 个命令，1 个失败')
  })

  it('更改完成显示去重文件数', () => {
    const s = buildFamilySummary(
      'changes',
      [tool('edit', { path: '/a.ts' }), tool('edit', { path: '/a.ts' }), tool('write', { path: '/b.ts' })],
      false,
    )
    expect(s.text).toBe('2 个文件')
  })

  it('查阅完成按类别计数', () => {
    const s = buildFamilySummary(
      'explore',
      [tool('grep', { pattern: 'x' }), tool('grep', { pattern: 'y' }), tool('read', { path: '/a.ts' })],
      false,
    )
    expect(s.text).toBe('2 次搜索，1 个文件')
  })

  it('查阅运行中显示最新子工具动作 + 目标', () => {
    const s = buildFamilySummary(
      'explore',
      [tool('grep', { pattern: 'x' }), tool('read', { path: '/src/a.ts' }, 'running')],
      true,
    )
    expect(s.text).toContain('正在读取文件')
    expect(s.text).toContain('a.ts')
  })

  it('摘要 key 随内容变化（驱动纵向翻滚）', () => {
    const a = buildFamilySummary('execute', [tool('bash', { command: 'a' })], true)
    const b = buildFamilySummary('execute', [tool('bash', { command: 'b' })], true)
    expect(a.key).not.toBe(b.key)
  })
})
