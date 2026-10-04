/**
 * 面板栏打开页（v5.0 · docs/layout-design.md §5）——三个全宽按钮（文件树/
 * 终端/预览），点击=开出或激活对应页签/终端行。ZCode home 按钮范式。
 */
import { MousePointerClickIcon, SquareTerminalIcon, FolderTreeIcon, EyeIcon } from 'lucide-react'

export interface OpenPageAction {
  icon: typeof FolderTreeIcon
  label: string
  hint: string
  onOpen(): void
}

export function OpenPage({ actions }: { actions: OpenPageAction[] }) {
  return (
    <div className="open-page" data-slot="open-page">
      <h2 className="open-page-title">打开</h2>
      <div className="open-page-actions">
        {actions.map((a) => (
          <button
            key={a.label}
            className="open-page-btn"
            onClick={a.onOpen}
            type="button"
          >
            <a.icon className="open-page-btn-icon" size={18} strokeWidth={1.6} />
            <span className="open-page-btn-label">{a.label}</span>
            <span className="open-page-btn-hint">{a.hint}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

export { MousePointerClickIcon, SquareTerminalIcon, FolderTreeIcon, EyeIcon }
