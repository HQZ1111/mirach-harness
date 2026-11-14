/**
 * 弹层动效归拢守卫（2026-10-26 用户定稿）。
 *
 * 用户："能不能归拢成一个，现在输入框的模型选择，右键，左侧栏，三种效果，
 * 所有的弹窗效果归拢成一个"。
 *
 * 归拢前的三种实现（各自为政）：
 *   1. 模型选择器 = components/motion/popover.tsx 的 goo
 *   2. 右键菜单   = context-menu.tsx 的 clip-path 展开
 *   3. 侧栏菜单   = Radix + CSS 的 opacity/scale 缩放淡入
 *
 * 归拢后：**所有有锚点的弹层都渲染 goo-layer.tsx 的 GooSurface**，
 * 几何只有 buildGooGeometry 一份。这个测试锁住两件事：
 *
 * - 几何函数对"锚点式"与"落点式"两种输入给出同一坐标系下的正确包围盒；
 * - 已归拢的调用点**不允许**再出现自己的 clip 形变实现（防止下次有人
 *   又"顺手"在某个组件里写一套动画）。
 *
 * 纯函数 + 源码扫描，node 环境即可（无 DOM）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  buildGooGeometry,
  gooAnchorCutout,
  gooClipPath,
} from '@/components/motion/goo-layer'

const SRC = join(process.cwd(), 'src')

const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

/** 从 `inset(top right bottom left round r)` 里抠出四边数值。 */
function parseInset(clip: string) {
  const m = clip.match(
    /inset\((-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px (-?[\d.]+)px round ([\d.]+)px\)/,
  )
  if (!m) throw new Error(`不是 inset clip: ${clip}`)
  return {
    top: Number(m[1]),
    right: Number(m[2]),
    bottom: Number(m[3]),
    left: Number(m[4]),
    r: Number(m[5]),
  }
}

describe('buildGooGeometry', () => {
  it('锚点式：面板在锚点下方（Popover side=bottom）', () => {
    // 触发钮 100×32，面板 280×200，间距 14，对齐 start
    const geo = buildGooGeometry(100, 32, 0, 32 + 14, 280, 200, 16)
    // `-0` 是 Math.min(0, 0) 的产物，语义上等于 0（toEqual 区分两者）
    expect(geo.anchor.x + 0).toBe(0)
    expect(geo.anchor.y + 0).toBe(0)
    expect(geo.anchor).toMatchObject({ w: 100, h: 32, r: 16 })
    expect(geo.panel).toEqual({ x: 0, y: 46, w: 280, h: 200, r: 16 })
    expect(geo.layerW).toBe(280)
    expect(geo.layerH).toBe(246)
    expect(geo.left + 0).toBe(0)
    expect(geo.top + 0).toBe(0)
  })

  it('锚点式：面板向左上溢出时包围盒跟着扩（left/top 为负）', () => {
    // align=end 且面板比触发钮宽 → panelX 为负；side=top → panelY 为负
    const geo = buildGooGeometry(100, 32, 100 - 280, -(14 + 200), 280, 200, 16)
    expect(geo.left).toBe(-180)
    expect(geo.top).toBe(-214)
    expect(geo.layerW).toBe(280)
    expect(geo.layerH).toBe(246)
    // 锚点在扩大的包围盒里被平移
    expect(geo.anchor.x).toBe(180)
    expect(geo.anchor.y).toBe(214)
    // 面板左上落在包围盒原点
    expect(geo.panel.x).toBe(0)
    expect(geo.panel.y).toBe(0)
  })

  it('落点式：锚点是 0×0 的点，面板偏移就是落点到面板的距离', () => {
    // 右键落点 (900,600)，面板钳位后落在 (800,600)，尺寸 240×320
    const geo = buildGooGeometry(0, 0, 800 - 900, 600 - 600, 240, 320, 12)
    expect(geo.anchor.w).toBe(0)
    expect(geo.anchor.h).toBe(0)
    // 面板向左溢出 100px → 包围盒左边界跟着扩
    expect(geo.left).toBe(-100)
    expect(geo.layerW).toBe(240)
    expect(geo.layerH).toBe(320)
    // 锚点（落点）在包围盒里的位置 = 100
    expect(geo.anchor.x).toBe(100)
    expect(geo.panel.x).toBe(0)
  })

  it('落点式的锚点没有面积，不生成 trigger cutout', () => {
    const geo = buildGooGeometry(0, 0, 0, 0, 240, 320, 12)
    expect(gooAnchorCutout(geo)).toBeUndefined()
  })

  it('锚点式要挖掉触发钮（否则 goo 层盖住真按钮的标签）', () => {
    const geo = buildGooGeometry(100, 32, 0, 46, 280, 200, 16)
    expect(gooAnchorCutout(geo)).toContain('path(evenodd')
  })
})

describe('gooClipPath 收起终点', () => {
  // 触发钮 28×28 在 (100,100)，面板 288×200 从下方 6px 处长出来
  const geo = buildGooGeometry(28, 28, 0, 28 + 6, 288, 200, 12)

  it('goo=true：收起终点是锚点矩形（液滴脖子形成的过程）', () => {
    const at0 = parseInset(gooClipPath(geo, 0, false, true))
    // 锚点在包围盒里是 (0,0,28,28)
    expect(at0).toMatchObject({ top: 0, left: 0, right: 288 - 28, bottom: 234 - 28 })
  })

  it('goo=false：收起终点是面板上边（不是盖住按钮的白方块）', () => {
    // 面板在包围盒里是 (0, 34, 288, 200)；包围盒 288×234
    const at0 = parseInset(gooClipPath(geo, 0, false, false))
    // 一条贴面板上边、高 0、宽满的线：top=34、bottom=234-34、left=0、right=0
    expect(at0).toMatchObject({ top: 34, bottom: 200, left: 0, right: 0 })
  })

  it('goo=false：任何进度下都不越出面板（不会盖到触发钮上）', () => {
    const panelTop = geo.panel.y
    const panelBottom = geo.panel.y + geo.panel.h
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const clip = parseInset(gooClipPath(geo, p, false, false))
      const top = clip.top
      const bottom = geo.layerH - clip.bottom
      expect(top).toBeGreaterThanOrEqual(panelTop - 0.001)
      expect(bottom).toBeLessThanOrEqual(panelBottom + 0.001)
    }
  })

  it('goo=false：面板在上方时从下边长出来', () => {
    const above = buildGooGeometry(28, 28, 0, -(6 + 200), 288, 200, 12)
    // 面板在包围盒里 y=0..200，包围盒高 234，锚点在 y=206..234
    const at0 = parseInset(gooClipPath(above, 0, false, false))
    expect(at0).toMatchObject({ top: 200, bottom: 234 - 200, left: 0, right: 0 })
  })

  it('goo=false：面板在右侧时从左边长出来（align=start 不会被误判成左边对齐）', () => {
    // 锚点 28 宽，面板左边与锚点左边对齐、位于右侧 gap=6
    const right = buildGooGeometry(28, 28, 28 + 6, 0, 200, 100, 12)
    const at0 = parseInset(gooClipPath(right, 0, false, false))
    // 面板 x=34..234，包围盒宽 234；从左边长出 → 一条零宽竖线在 x=34：
    // left=34，right=234-34=200，高满（top=0 / bottom=0）
    expect(at0).toMatchObject({ left: 34, right: 200, top: 0, bottom: 0 })
  })
})

describe('goo 开关只有令牌一个来源', () => {
  it('tokens.css 定义 --beui-popover-goo', () => {
    expect(read('styles/tokens.css')).toMatch(/--beui-popover-goo:\s*\d/)
  })

  it('ease.ts 导出 POPOVER_GOO 并从令牌读取', () => {
    const ease = read('lib/ease.ts')
    expect(ease).toContain('export const POPOVER_GOO')
    expect(ease).toContain('--beui-popover-goo')
  })

  it('三个组件的 goo 默认值都取 POPOVER_GOO', () => {
    for (const f of [
      'components/motion/goo-layer.tsx',
      'components/motion/popover.tsx',
      'components/motion/context-menu.tsx',
    ]) {
      expect(read(f), `${f} 的 goo 默认值必须是 POPOVER_GOO`).toMatch(
        /goo = POPOVER_GOO/,
      )
    }
  })

  it('调用点不许传 goo（散在调用点的布尔参数 = 观感漂移）', () => {
    // 只允许组件内部转发：popover.tsx 的 goo={goo}、context-menu.tsx 的
    // goo={context.goo}
    const allowed = new Set([
      'components/motion/popover.tsx',
      'components/motion/context-menu.tsx',
    ])
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, name.name)
        if (name.isDirectory()) {
          walk(p)
          continue
        }
        if (!/\.tsx?$/.test(name.name)) continue
        const rel = p.slice(SRC.length + 1).split(sep).join('/')
        if (allowed.has(rel)) continue
        // 注释里提到这个 prop 不算调用：先剥掉块注释与行注释再判。
        // （JSX 的 {/* */} 就是块注释；行注释要先剥块注释才安全。）
        const code = readFileSync(p, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')
        if (/\bgoo=\{/.test(code)) offenders.push(rel)
      }
    }
    walk(SRC)
    expect(offenders).toEqual([])
  })
})

describe('弹层动效只有一个来源', () => {
  it('goo-layer 是唯一的 goo 滤镜实现', () => {
    // 只认真正的 JSX 标签（注释里提到 feGaussianBlur 不算实现）
    const owners = [
      'components/motion/goo-layer.tsx',
      'components/motion/popover.tsx',
      'components/motion/context-menu.tsx',
    ].filter((f) => read(f).includes('<feGaussianBlur'))
    expect(owners).toEqual(['components/motion/goo-layer.tsx'])
  })

  it('右键菜单与 popover 都走 GooSurface', () => {
    for (const f of ['components/motion/popover.tsx', 'components/motion/context-menu.tsx']) {
      expect(read(f), `${f} 必须 import GooSurface`).toContain('GooSurface')
    }
  })

  it('CSS 不再给菜单类弹层挂 keyframes（会覆盖 goo 形变）', () => {
    const css = read('styles/ui-primitives.css')
    // 归拢前这三条选择器把菜单的 clip 形变覆盖成缩放淡入
    expect(css).not.toContain("[role='menu'][data-state='open']")
    expect(css).not.toContain("[data-radix-popper-content-wrapper] > [data-state='open']")
    // 对话框（居中、无锚点）仍保留
    expect(css).toContain("[data-slot='dialog-content'][data-state='open']")
  })

  it('会话行 / 侧栏 / 文件树 / 标签条都用自家 ContextMenu（无 Radix DropdownMenu）', () => {
    const files = [
      'components/thread-list.aui.tsx',
      'components/panes/workspace-file-tree/WorkspaceFileTreeRowView.tsx',
      'components/layout/tab-strip-new.tsx',
      'components/layout/app-context-menu.tsx',
    ]
    for (const f of files) {
      const src = read(f)
      expect(src, `${f} 不应再 import Radix DropdownMenu`).not.toMatch(
        /DropdownMenu\b.*from ['"]radix-ui['"]/,
      )
    }
  })
})
