export interface PlaceholderPaneProps {
  title: string
  description: string
  hints?: string[]
}

/** 占位窗格：布局骨架阶段的通用内容壳。 */
export function PlaceholderPane({ title, description, hints = [] }: PlaceholderPaneProps) {
  return (
    <div className="pane-placeholder">
      <h2>{title}</h2>
      <p>{description}</p>
      {hints.length > 0 && (
        <ul>
          {hints.map(hint => (
            <li key={hint} style={{ fontSize: 12.5, color: '#8f8f9c', lineHeight: 1.7 }}>
              {hint}
            </li>
          ))}
        </ul>
      )}
      <p className="hint">窗格内容待接真实数据 —— 布局骨架阶段仅占位。</p>
    </div>
  )
}
