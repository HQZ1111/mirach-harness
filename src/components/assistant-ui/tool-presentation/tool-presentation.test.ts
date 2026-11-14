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

  it('rpi 插件工具：delegate_task / orchestrator 三件套 → 子代理', () => {
    for (const name of ['delegate_task', 'subagent', 'dispatch']) {
      expect(describeToolCall({ name, args: { task: 'do it' } }).category).toBe('agent')
    }
    // orchestrator 的 plan = 任务分解（plan 分类，不是内核 submit_plan）
    expect(describeToolCall({ name: 'plan', args: {} }).category).toBe('plan')
    expect(describeToolCall({ name: 'delegate_task', args: { task: 't' } }).phrase).toBe('runAgent')
    expect(describeToolCall({ name: 'delegate_task', args: {} }).body).toBe('agent')
    expect(describeToolCall({ name: 'ask_user', args: { question: 'q' } }).phrase).toBe('askUser')
  })

  it('rpi 插件工具：checkpoint / mcp / plan-mode / langfuse', () => {
    expect(describeToolCall({ name: 'checkpoint_mark', args: {} }).phrase).toBe('markCheckpoint')
    expect(describeToolCall({ name: 'checkpoint_list', args: {} }).phrase).toBe('listCheckpoints')
    expect(describeToolCall({ name: 'checkpoint_rewind', args: {} }).phrase).toBe('rewindCheckpoint')
    expect(describeToolCall({ name: 'mcp_call', args: { tool: 'fs_read' } }).phrase).toBe('useMcp')
    expect(describeToolCall({ name: 'mcp_list', args: {} }).phrase).toBe('useMcp')
    expect(describeToolCall({ name: 'plan_mode_start', args: {} }).phrase).toBe('startPlanMode')
    expect(describeToolCall({ name: 'plan_mode_complete', args: {} }).phrase).toBe('finishPlan')
    expect(describeToolCall({ name: 'langfuse_trace', args: {} }).source).toBe('family')
    expect(describeToolCall({ name: 'langfuse_trace', args: {} }).phrase).toBe('useLangfuse')
    expect(describeToolCall({ name: 'websearch', args: { query: 'x' } }).phrase).toBe('searchWeb')
    expect(describeToolCall({ name: 'webfetch', args: { url: 'https://a.dev/b' } }).chip).toBe('a.dev/b')
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
