import { PlaceholderPane } from './placeholder-pane'

export function ReviewPane() {
  return (
    <PlaceholderPane
      title="检查"
      description="右栏：检查面板占位。"
      hints={['diff / 变更审阅']}
    />
  )
}
