/**
 * 面板栏打开页（docs/layout-design.md v6.0 §7）——面板栏默认显示本页；
 * 三个全宽按钮（ZCode home 按钮范式：图标 + 文字 + 提示位），点击 = 开出
 * 或激活对应页签/终端行。动作经 props 由 flex-layout 工厂注入（需要模型，
 * 见 flex-layout.tsx 的 openPanelsAction）。
 */
import { EyeIcon, FolderTreeIcon, SquareTerminalIcon } from 'lucide-react'

export type OpenPageKind = 'files' | 'terminal' | 'preview'

const ACTIONS: { kind: OpenPageKind; icon: typeof FolderTreeIcon; label: string; hint: string }[] = [
  { kind: 'files', icon: FolderTreeIcon, label: '文件树', hint: '浏览工作区文件' },
  { kind: 'terminal', icon: SquareTerminalIcon, label: '终端', hint: '打开终端行' },
  { kind: 'preview', icon: EyeIcon, label: '预览', hint: '预览打开的文件' },
]

export function OpenPage({ onOpen }: { onOpen(kind: OpenPageKind): void }) {
  return (
    <div className="open-page" data-slot="open-page">
      <h2 className="open-page-title">打开</h2>
      <div className="open-page-actions">
        {ACTIONS.map((a) => (
          <button
            key={a.kind}
            className="open-page-btn"
            onClick={() => onOpen(a.kind)}
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
