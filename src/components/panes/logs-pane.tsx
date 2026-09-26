import { PlaceholderPane } from './placeholder-pane'

export function LogsPane() {
  return (
    <PlaceholderPane
      title="日志"
      description="工具面板：日志流占位（hermes logs pane，dock 在终端旁）。"
      hints={['日志源接 pi agent rust（待接）']}
    />
  )
}
