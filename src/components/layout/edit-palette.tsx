/**
 * 布局编辑面板 —— 逐字对照 hermes edit-bar.tsx + layout-picker.tsx。
 * 编辑模式下浮动的可拖动"Layouts" 卡片，承载预设网格（带缩略图）。
 * 另存当前布局、删除自定义预设、重置、完成；卡片头即拖拽把手。
 * 文案逐字取自 hermes zh catalog（zones.editTitle/editHint/…）。
 *
 * 与 hermes 的差异（transport 层适配，非逻辑改动）：
 * - hermes 的预设走 contrib registry + LayoutNode 树；这里用 flexlayout JSON
 *   （行方向由深度奇偶交替，缩略图按深度渲染）。
 * - 用户预设的存取在 flex-layout（对应 hermes tree/presets.ts store 职责），
 *   本组件只渲染 + 回调。
 * - hermes 的编辑模式开关是 keybind（layout.editMode）；harness 标题栏按钮
 *   + Ctrl+Shift+\。
 * - harness 无 Tailwind，样式走 styles/editor.css 的 .ep-*（对照 hermes
 *   tailwind 类逐条翻译，z 序在 veil 之上）。
 */

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { LAYOUT_PRESETS, type StoredPreset } from './layout-presets'

// ── 缩略图（hermes TreeThumbnail：flexlayout 行方向按深度交替）──────────────

const TreeThumbnail = ({ node, depth = 0 }: { node: any; depth?: number }) => {
  if (node.type === 'tabset') {
    // currentColor 派生填充：暗主题上亮块、亮主题上暗块，不依赖 accent
    return (
      <div
        className="ep-thumb-zone"
        // color-mix(currentColor 16%)（hermes 同式）
        style={{ background: 'color-mix(in srgb, currentColor 16%, transparent)' }}
      />
    )
  }
  // flexlayout 的 row 水平，嵌套 row 交替（深度偶数=横排，奇数=竖排）
  const children: any[] = node.children ?? []
  const total = children.reduce((sum, c) => sum + (c.weight ?? 1), 0) || 1
  return (
    <div className={`ep-thumb-row${depth % 2 === 0 ? ' ep-thumb-horz' : ' ep-thumb-vert'}`}>
      {children.map((child, i) => {
        const w = (child.weight ?? 1) / total
        return (
          <div className="ep-thumb-cell" key={i} style={{ flex: `${w} ${w} 0px` }}>
            <TreeThumbnail node={child} depth={depth + 1} />
          </div>
        )
      })}
    </div>
  )
}

// ── 预设卡（hermes PresetCard）──────────────────────────────────────────────

const PresetCard = ({
  title,
  tree,
  active,
  deletable,
  onApply,
  onDelete,
}: {
  title: string
  tree: any
  active: boolean
  deletable: boolean
  onApply: () => void
  onDelete: () => void
}) => {
  return (
    <div className="ep-preset">
      <button className={`ep-preset-btn${active ? ' ep-preset-active' : ''}`} onClick={onApply} type="button">
        <div className="ep-preset-thumb">
          <TreeThumbnail node={tree} />
        </div>
        <span className="ep-preset-name">{title}</span>
      </button>
      {deletable && (
        <button
          aria-label={`删除 ${title}`}
          // 悬停显形（opacity 而非 display）——占位保留、悬停/键盘聚焦时出现
          className="ep-preset-del"
          onClick={onDelete}
          onPointerDown={(e) => e.stopPropagation()}
          type="button"
        >
          ×
        </button>
      )}
    </div>
  )
}

// ── 面板本体（hermes TreeEditBar + LayoutPicker）────────────────────────────

// 面板位置跨编辑模式开关存活（会话内）；null = 居中
let lastPalettePos: { x: number; y: number } | null = null

export function EditPalette({
  activePresetId,
  userPresets,
  currentJson,
  onApplyTemplate,
  onApplyUser,
  onSaveCurrent,
  onDeleteUser,
  onOpenZoneEditor,
  onClose,
}: {
  activePresetId: string | null
  userPresets: StoredPreset[]
  currentJson: () => unknown
  onApplyTemplate: (id: string) => void
  onApplyUser: (id: string) => void
  onSaveCurrent: (title: string) => void
  onDeleteUser: (id: string) => void
  onOpenZoneEditor: () => void
  onClose: () => void
}) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [pos, setPos] = useState(lastPalettePos)
  const cardRef = useRef<HTMLDivElement>(null)

  const startMove = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return
    const card = cardRef.current
    const parent = card?.parentElement
    if (!card || !parent) return
    e.preventDefault()
    const cardRect = card.getBoundingClientRect()
    const dx = e.clientX - cardRect.x
    const dy = e.clientY - cardRect.y
    const onMove = (ev: PointerEvent) => {
      const parentRect = parent.getBoundingClientRect()
      const next = {
        x: Math.max(4, Math.min(parentRect.width - cardRect.width - 4, ev.clientX - parentRect.x - dx)),
        y: Math.max(4, Math.min(parentRect.height - 40, ev.clientY - parentRect.y - dy)),
      }
      lastPalettePos = next
      setPos(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  return (
    <div
      className="ep-card"
      ref={cardRef}
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      data-centered={pos ? undefined : ''}
    >
      {/* 头部即拖拽把手（hermes TreeEditBar：标题 + 提示 + 键位 kbd + 重置/完成）*/}
      <header className="ep-header" onPointerDown={startMove}>
        <div className="min-w-0">
          <h2 className="ep-title">布局</h2>
          <p className="ep-hint">
            选择一个布局，或在区域之间拖动面板。{' '}
            <kbd className="ep-kbd">Ctrl+Shift+\</kbd>
          </p>
        </div>
        <div className="ep-header-actions" onPointerDown={(e) => e.stopPropagation()}>
          <button className="ep-btn" onClick={() => onApplyTemplate('default')} type="button">
            重置
          </button>
          <button className="ep-btn ep-btn-outline" onClick={onClose} type="button">
            完成
          </button>
        </div>
      </header>
      <div className="ep-body">
        <div className="ep-sections">
          <section className="ep-section">
            <span className="ep-label">模板</span>
            <div className="ep-grid">
              {LAYOUT_PRESETS.map((p) => (
                <PresetCard
                  key={p.id}
                  title={p.title}
                  tree={p.build()}
                  active={activePresetId === p.id}
                  deletable={false}
                  onApply={() => onApplyTemplate(p.id)}
                  onDelete={() => {}}
                />
              ))}
            </div>
          </section>
          <section className="ep-section">
            <span className="ep-label">自定义</span>
            {userPresets.length > 0 && (
              <div className="ep-grid">
                {userPresets.map((p) => (
                  <PresetCard
                    key={p.id}
                    title={p.title}
                    tree={((p.json as any)?.layout ?? p.json) as any}
                    active={activePresetId === p.id}
                    deletable
                    onApply={() => onApplyUser(p.id)}
                    onDelete={() => onDeleteUser(p.id)}
                  />
                ))}
              </div>
            )}
            {/* hermes「New grid layout」：打开 zone 编辑器从零画分叉树 */}
            <button className="ep-new-grid" onClick={onOpenZoneEditor} type="button">
              + 新建网格布局
            </button>
            {/* 另存当前藏在显形层后面，避免裸输入框和卡片网格打架 */}
            {saving ? (
              <form
                className="ep-save-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  onSaveCurrent(name.trim())
                  setName('')
                  setSaving(false)
                }}
              >
                <input
                  autoFocus
                  className="ep-input"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      setSaving(false)
                      setName('')
                    }
                  }}
                  placeholder="为布局命名…"
                  value={name}
                />
                <button className="ep-btn ep-btn-outline" disabled={!name.trim()} type="submit">
                  保存
                </button>
                <button
                  className="ep-btn"
                  onClick={() => setSaving(false)}
                  type="button"
                >
                  取消
                </button>
              </form>
            ) : (
              <button className="ep-save-reveal" onClick={() => setSaving(true)} type="button">
                <svg aria-hidden fill="currentColor" height="13" viewBox="0 0 16 16" width="13">
                  {/* codicon "save" */}
                  <path d="M13.35 2.5l.65.65v9.7l-.65.65H2.65L2 12.85V3.15l.65-.65h10.7zM13 3.5H11V6H5V3.5H3v9l.15.15h9.7l.15-.15v-9zM10 3.5H6V5h4V3.5zM8 9.5a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
                </svg>
                将当前排列保存为模板
              </button>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
