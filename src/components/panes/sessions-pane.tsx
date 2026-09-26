import { PlaceholderPane } from './placeholder-pane'

export function SessionsPane() {
  return (
    <PlaceholderPane
      title="会话列表"
      description="左栏：会话列表占位。"
      hints={['新建会话 / 置顶 / 分组筛选', '会话行点击 → 主区打开']}
    />
  )
}
