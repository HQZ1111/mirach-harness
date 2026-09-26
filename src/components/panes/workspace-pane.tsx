import { PlaceholderPane } from './placeholder-pane'

export function WorkspacePane({ tabName }: { tabName?: string }) {
  return (
    <PlaceholderPane
      title={tabName ?? '主区'}
      description={`${tabName ?? '主区'}：当前会话 / 工作区占位。`}
      hints={['对话流、composer 未来接 pi agent rust']}
    />
  )
}
