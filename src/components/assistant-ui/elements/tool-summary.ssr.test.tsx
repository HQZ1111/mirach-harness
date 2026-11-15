/**
 * 工具摘要行（ZCode ToolLayout/ToolSummaryRow 的宿主移植）静态渲染断言：
 * 摘要行必须把「类别词 / 关键参数 chip / 状态词 / diff 计数」渲染在同一行，
 * 失败态走红显 + 虚线 tooltip，收起态不渲染正文。
 *
 * node 环境无 jsdom：用 react-dom/server 断言结构（不点交互——交互语义由
 * 组件内的 Collapsible 负责，属框架行为）。
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { WrenchIcon } from 'lucide-react'

import { ToolDiffStat, ToolSummary } from './tool-summary.aui'

const base = {
  toolId: 'tc-1',
  icon: <WrenchIcon />,
  kindLabel: '已读取',
}

const render = (node: React.ReactElement) => renderToStaticMarkup(node)

describe('ToolSummary', () => {
  it('摘要行 = 类别词 + 参数 chip + 状态词 + 展开语义', () => {
    const html = render(
      <ToolSummary
        {...base}
        primaryText="…/src/main.ts"
        statusLabel="已执行"
        content={<p>正文</p>}
      />,
    )
    expect(html).toContain('data-slot="aui_tool-summary"')
    expect(html).toContain('data-tool-state="done"')
    expect(html).toContain('已读取')
    expect(html).toContain('…/src/main.ts')
    expect(html).toContain('已执行')
    expect(html).toContain('role="button"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('aria-label="展开工具详情"')
    // 收起态不渲染正文（CollapsibleContent 未挂载）
    expect(html).not.toContain('正文')
  })

  it('运行态类别词带扫光类（shimmer），图标不旋转', () => {
    const html = render(
      <ToolSummary {...base} kindLabel="正在读取" running statusLabel="执行中" />,
    )
    expect(html).toContain('data-tool-state="running"')
    expect(html).toContain('shimmer')
    expect(html).not.toContain('animate-spin')
  })

  it('失败态：红显状态词 + 虚线 tooltip 语义（不是错误卡）', () => {
    const html = render(
      <ToolSummary
        {...base}
        kindLabel="已编辑"
        statusLabel="执行失败"
        failed
        statusTooltip="permission denied"
      />,
    )
    expect(html).toContain('data-tool-state="failed"')
    expect(html).toContain('执行失败')
    expect(html).toContain('text-red-500')
    expect(html).toContain('decoration-dotted')
    expect(html).not.toContain('ring-destructive')
  })

  it('不可展开（read/搜索行）：无 role=button、无展开说明', () => {
    const html = render(
      <ToolSummary {...base} primaryText="query" statusLabel="已执行" canToggle={false} />,
    )
    expect(html).not.toContain('role="button"')
    expect(html).not.toContain('aria-expanded')
  })

  it('diff 计数：+N 绿 / −N 红，缺席不同时渲染', () => {
    const both = render(<ToolDiffStat added={3} removed={1} />)
    expect(both).toContain('+3')
    expect(both).toContain('−1')
    expect(both).toContain('text-emerald-600')
    expect(both).toContain('text-red-600')
    expect(render(<ToolDiffStat added={0} removed={0} />)).toBe('')
  })
})
