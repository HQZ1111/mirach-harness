import { describe, expect, it } from 'vitest'
import {
  activeSummaryIndex,
  buildWorkSummaryItems,
  changedFileOf,
  classifySummaryCategory,
  collectChangedFiles,
  countPiDiff,
  formatSummaryStatistics,
  hiddenReasoningIndices,
  isSummaryRow,
  isTailSummaryGroup,
  normalizeSummaryPath,
  summaryChangeFiles,
  summaryFileLeafName,
  summaryIconIndex,
  type SummaryPartLike,
} from './work-summary'

const tool = (toolName: string, over: Partial<SummaryPartLike> = {}): SummaryPartLike => ({
  type: 'tool-call',
  toolName,
  args: {},
  status: { type: 'complete' },
  ...over,
})
const reasoning = (over: Partial<SummaryPartLike> = {}): SummaryPartLike => ({
  type: 'reasoning',
  text: '想一想',
  status: { type: 'complete' },
  ...over,
})
const text = (t: string): SummaryPartLike => ({ type: 'text', text: t })

describe('classifySummaryCategory（ZCode getAssistantSummaryToolCategory）', () => {
  it('思考行可进组但没有工具类别（不计数）', () => {
    expect(classifySummaryCategory(reasoning())).toBeNull()
    expect(isSummaryRow(reasoning())).toBe(true)
  })

  it('explore：读文件 / 搜索 / 抓网页（含 rpi 的 websearch 别名）', () => {
    for (const name of ['read', 'ls', 'image', 'grep', 'find', 'ast_grep', 'lsp', 'web_search', 'websearch', 'webfetch']) {
      expect(classifySummaryCategory(tool(name))).toBe('explore')
    }
  })

  it('run：shell / powershell / node-repl', () => {
    for (const name of ['bash', 'powershell', 'node_repl']) {
      expect(classifySummaryCategory(tool(name))).toBe('run')
    }
  })

  it('change：四个写文件工具', () => {
    for (const name of ['edit', 'write', 'hashline_edit', 'ast_edit']) {
      expect(classifySummaryCategory(tool(name))).toBe('change')
    }
  })

  it('session 工具独立类别（统计并入执行数，图标优先级最低）', () => {
    expect(classifySummaryCategory(tool('session_list'))).toBe('session')
    expect(classifySummaryCategory(tool('session_read'))).toBe('session')
    expect(classifySummaryCategory(tool('session'))).toBe('session')
  })

  it('子代理 / 委托工具是边界（不进口组）', () => {
    expect(classifySummaryCategory(tool('subagent'))).toBeNull()
    expect(classifySummaryCategory(tool('delegate_task'))).toBeNull()
    expect(classifySummaryCategory(tool('Task'))).toBeNull()
    expect(classifySummaryCategory(tool('Agent'))).toBeNull()
  })

  it('未归类工具 / 待审批 / 正文 / 图片是边界', () => {
    expect(classifySummaryCategory(tool('submit_plan'))).toBeNull()
    expect(classifySummaryCategory(tool('mcp__foo__bar'))).toBeNull()
    expect(classifySummaryCategory(tool('read', { status: { type: 'requires-action' } }))).toBeNull()
    expect(classifySummaryCategory(text('正文'))).toBeNull()
    expect(classifySummaryCategory({ type: 'image' })).toBeNull()
    expect(isSummaryRow(text('正文'))).toBe(false)
  })
})

describe('buildWorkSummaryItems（连续摘要组扫描）', () => {
  it('思考 + 工具的连续段合成一个 rows 项', () => {
    const parts = [reasoning(), tool('read'), tool('bash'), reasoning(), tool('grep')]
    const items = buildWorkSummaryItems(parts, [0, 1, 2, 3, 4])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'rows', indices: [0, 1, 2, 3, 4] })
  })

  it('子代理 / 未归类工具是边界；非空正文并进当前组（宿主偏差：不再切碎总项）', () => {
    const parts = [
      tool('read'),
      text('中间正文'),
      tool('bash'),
      tool('submit_plan'),
      tool('grep'),
      tool('subagent'),
    ]
    const items = buildWorkSummaryItems(parts, [0, 1, 2, 3, 4, 5])
    expect(items.map((item) => item.kind)).toEqual([
      'rows',
      'part',
      'rows',
      'part',
    ])
    expect(items[0]).toMatchObject({ kind: 'rows', indices: [0, 1, 2] })
    expect(items[2]).toMatchObject({ kind: 'rows', indices: [4] })
  })

  it('待办工具被剔除：不渲染、也不断组', () => {
    const parts = [tool('read'), tool('todo'), tool('grep')]
    const items = buildWorkSummaryItems(parts, [0, 1, 2])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'rows', indices: [0, 2] })
  })

  it('空文本 / 空思考不渲染也不断组（流式空 delta 不再拆碎总项）', () => {
    const parts = [
      tool('read'),
      text(''),
      tool('bash'),
      reasoning({ text: '' }),
      tool('grep'),
      text('   '),
      tool('edit', { args: { path: 'a.ts' } }),
    ]
    const items = buildWorkSummaryItems(parts, [0, 1, 2, 3, 4, 5, 6])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'rows', indices: [0, 2, 4, 6] })
  })

  it('非空正文并进当前组（宿主偏差：一轮只保留一个总项）', () => {
    const parts = [tool('read'), text('x'), tool('bash')]
    const items = buildWorkSummaryItems(parts, [0, 1, 2])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'rows', indices: [0, 1, 2] })
  })

  it('单个可归类行也是 rows 项（渲染层再摊平成普通行）', () => {
    const items = buildWorkSummaryItems([reasoning()], [0])
    expect(items).toEqual([{ kind: 'rows', key: 'rows:0', indices: [0] }])
  })

  it('只扫给定下标（工作段内），越界下标忽略', () => {
    const parts = [tool('read'), tool('bash'), tool('grep')]
    const items = buildWorkSummaryItems(parts, [1, 9])
    expect(items).toEqual([{ kind: 'rows', key: 'rows:1', indices: [1] }])
  })

  it('隐藏的非首条思考被剔除、不断组（showReasoning=false，ZCode 同语义）', () => {
    const parts = [
      reasoning({ text: '第一条思考' }),
      tool('read'),
      reasoning({ text: '第二条思考' }),
      tool('bash'),
      reasoning({ text: '第三条思考' }),
    ]
    const hidden = hiddenReasoningIndices(parts, false)
    expect([...hidden].sort()).toEqual([2, 4])
    const items = buildWorkSummaryItems(parts, [0, 1, 2, 3, 4], { hiddenReasoning: hidden })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'rows', indices: [0, 1, 3] })
  })

  it('空思考不占「第一条」的位置；showReasoning=true 时无隐藏', () => {
    const parts = [
      reasoning({ text: '' }),
      reasoning({ text: '真正的第一条' }),
      reasoning({ text: '第二条' }),
    ]
    expect([...hiddenReasoningIndices(parts, false)]).toEqual([2])
    expect(hiddenReasoningIndices(parts, true).size).toBe(0)
  })

  it('显示待办时 todo 行作为普通部件进流（ZCode showTodoToolCalls=true）', () => {
    const parts = [tool('read'), tool('todo'), tool('grep')]
    const items = buildWorkSummaryItems(parts, [0, 1, 2], { showTodos: true })
    expect(items.map((item) => item.kind)).toEqual(['rows', 'part', 'rows'])
    expect(items[0]).toMatchObject({ kind: 'rows', indices: [0] })
    expect(items[1]).toMatchObject({ kind: 'part', index: 1 })
    expect(items[2]).toMatchObject({ kind: 'rows', indices: [2] })
  })
})

describe('formatSummaryStatistics（组头统计文案）', () => {
  it('完成态：已查阅 / 已执行 / 已修改，逗号分隔', () => {
    const parts = [
      tool('grep'),
      tool('read'),
      tool('bash'),
      tool('powershell'),
      tool('edit', { args: { path: 'src/a.ts' } }),
      tool('write', { args: { path: 'src/b.ts' } }),
    ]
    expect(formatSummaryStatistics(parts, [0, 1, 2, 3, 4, 5], true)).toBe(
      '已查阅 2 项，已执行 2 命令，已修改 2 文件',
    )
  })

  it('运行态去掉「已」前缀', () => {
    const parts = [tool('grep'), tool('bash'), tool('write', { args: { path: 'a.ts' } })]
    expect(formatSummaryStatistics(parts, [0, 1, 2], false)).toBe(
      '查阅 1 项，执行 1 命令，修改 1 文件',
    )
  })

  it('change 按唯一文件路径计数（同一文件多次编辑算一个）', () => {
    const parts = [
      tool('edit', { args: { path: 'src/a.ts' } }),
      tool('edit', { args: { path: 'src/a.ts' } }),
      tool('write', { args: { path: 'src/b.ts' } }),
    ]
    expect(formatSummaryStatistics(parts, [0, 1, 2], true)).toBe('已修改 2 文件')
  })

  it('路径归一化后同文件只计一次（正反斜杠 / ./ 前缀）', () => {
    const parts = [
      tool('edit', { args: { path: 'src/a.ts' } }),
      tool('edit', { args: { path: 'src\\a.ts' } }),
      tool('edit', { args: { path: './src/a.ts' } }),
    ]
    expect(formatSummaryStatistics(parts, [0, 1, 2], true)).toBe('已修改 1 文件')
  })

  it('无路径的 change 计 unresolved（修改 N 次（路径未知））', () => {
    const parts = [tool('edit', { args: {} }), tool('edit', { args: { path: 'a.ts' } })]
    expect(formatSummaryStatistics(parts, [0, 1], true)).toBe(
      '已修改 1 文件，已修改 1 次（路径未知）',
    )
  })

  it('session 工具计入执行数', () => {
    const parts = [tool('session_list'), tool('bash')]
    expect(formatSummaryStatistics(parts, [0, 1], true)).toBe('已执行 2 命令')
  })

  it('只有思考 → 回退「思考」', () => {
    expect(formatSummaryStatistics([reasoning()], [0], true)).toBe('思考')
    expect(formatSummaryStatistics([reasoning()], [0], false)).toBe('思考')
  })

  it('思考不计数（不产出「查阅 N 项」）', () => {
    expect(formatSummaryStatistics([reasoning(), tool('read')], [0, 1], true)).toBe('已查阅 1 项')
  })
})

describe('normalizeSummaryPath / summaryFileLeafName', () => {
  it('统一斜杠、消掉 ./ 与 ..', () => {
    expect(normalizeSummaryPath('src\\a\\b.ts')).toBe('src/a/b.ts')
    expect(normalizeSummaryPath('./src/a.ts')).toBe('src/a.ts')
    expect(normalizeSummaryPath('src/x/../a.ts')).toBe('src/a.ts')
    expect(normalizeSummaryPath('C:\\proj\\src\\a.ts')).toBe('C:/proj/src/a.ts')
  })

  it('文件名取最后一段', () => {
    expect(summaryFileLeafName('C:\\proj\\src\\a.ts')).toBe('a.ts')
    expect(summaryFileLeafName('/a/b/c.tsx')).toBe('c.tsx')
    expect(summaryFileLeafName('a.ts')).toBe('a.ts')
  })
})

describe('changedFileOf / countPiDiff（文件与行数）', () => {
  it('edit 的 details.diff 按 marker 计增删', () => {
    expect(countPiDiff('+1 added\n-1 removed\n 2 ctx\n ...')).toEqual({
      additions: 1,
      deletions: 1,
    })
    const file = changedFileOf(
      tool('edit', {
        args: { path: 'src/a.ts' },
        result: { content: [], details: { diff: '+1 a\n+2 b\n-3 c' } },
      }),
    )
    expect(file).toEqual({ path: 'src/a.ts', additions: 2, removed: 1 })
  })

  it('write 无 diff：按写入内容行数计新增（pi WriteTool 无 generate_diff）', () => {
    const file = changedFileOf(
      tool('write', { args: { path: 'cdp-eval2.mjs', content: 'a\nb\nc\n' } }),
    )
    expect(file).toEqual({ path: 'cdp-eval2.mjs', additions: 3, removed: 0 })
  })

  it('write 无 content：行数 0（不编造）', () => {
    expect(changedFileOf(tool('write', { args: { path: 'a.ts' } }))).toEqual({
      path: 'a.ts',
      additions: 0,
      removed: 0,
    })
  })

  it('无路径 → null；非 change 工具 → null', () => {
    expect(changedFileOf(tool('edit', { args: {} }))).toBeNull()
    expect(changedFileOf(tool('read', { args: { path: 'a.ts' } }))).toBeNull()
  })

  it('collectChangedFiles 去重并统计 unresolved', () => {
    const parts = [tool('edit', { args: { path: 'a.ts' } }), tool('edit', { args: {} })]
    expect(collectChangedFiles(parts, [0, 1])).toEqual({
      files: [{ path: 'a.ts', additions: 0, removed: 0 }],
      unresolved: 1,
    })
  })
})

describe('summaryIconIndex（代表图标优先级 CUA 0 / node-repl 1 / change 2 / run 3 / explore 4）', () => {
  it('change 压过 run 与 explore', () => {
    const parts = [tool('grep'), tool('bash'), tool('edit', { args: { path: 'a.ts' } })]
    expect(summaryIconIndex(parts, [0, 1, 2])).toBe(2)
  })

  it('run 压过 explore', () => {
    const parts = [tool('read'), tool('bash')]
    expect(summaryIconIndex(parts, [0, 1])).toBe(1)
  })

  it('node-repl 压过 change', () => {
    const parts = [tool('edit', { args: { path: 'a.ts' } }), tool('node_repl')]
    expect(summaryIconIndex(parts, [0, 1])).toBe(1)
  })

  it('只有思考 → undefined（组头用思考图标）', () => {
    expect(summaryIconIndex([reasoning()], [0])).toBeUndefined()
  })
})

describe('activeSummaryIndex（收起态组头滚动的当前项）', () => {
  it('最后一个运行中的工具', () => {
    const parts = [
      tool('bash', { status: { type: 'complete' } }),
      tool('read', { status: { type: 'running' } }),
      tool('grep', { status: { type: 'running' } }),
    ]
    expect(activeSummaryIndex(parts, [0, 1, 2])).toBe(2)
  })

  it('流式思考也算活动项', () => {
    const parts = [tool('read'), reasoning({ status: { type: 'running' } })]
    expect(activeSummaryIndex(parts, [0, 1])).toBe(1)
  })

  it('全部完成 → undefined（组头切回统计文本）', () => {
    expect(activeSummaryIndex([tool('read'), tool('bash')], [0, 1])).toBeUndefined()
  })
})


describe('isTailSummaryGroup（只有整轮尾组可滚动当前项）', () => {
  it('running 且组尾 == 整轮尾行 → true', () => {
    expect(
      isTailSummaryGroup({ running: true, groupLastIndex: 7, turnTailIndex: 7 }),
    ).toBe(true)
  })

  it('非 running / 非尾行 / 正文成为尾行 → false', () => {
    expect(
      isTailSummaryGroup({ running: false, groupLastIndex: 7, turnTailIndex: 7 }),
    ).toBe(false)
    expect(
      isTailSummaryGroup({ running: true, groupLastIndex: 5, turnTailIndex: 7 }),
    ).toBe(false)
    // 最终正文（index 8）成为整轮尾行：组 0..7 都不再滚动
    expect(
      isTailSummaryGroup({ running: true, groupLastIndex: 7, turnTailIndex: 8 }),
    ).toBe(false)
  })
})

describe('summaryChangeFiles（纯 change 组的折叠文件清单）', () => {
  it('纯 change 返回去重文件表', () => {
    const parts = [
      tool('edit', { args: { path: 'src/a.ts' }, result: { content: [], details: { diff: '+1 x' } } }),
      tool('edit', { args: { path: 'src/a.ts' } }),
    ]
    const result = summaryChangeFiles(parts, [0, 1])
    expect(result?.files).toHaveLength(1)
    expect(result?.unresolved).toBe(0)
  })

  it('混入别的族 → undefined（保留统计文本）', () => {
    const parts = [tool('edit', { args: { path: 'a.ts' } }), tool('bash')]
    expect(summaryChangeFiles(parts, [0, 1])).toBeUndefined()
  })

  it('只有思考也算纯 change 组（思考不计数），但无文件 → undefined', () => {
    expect(summaryChangeFiles([reasoning()], [0])).toBeUndefined()
  })
})
