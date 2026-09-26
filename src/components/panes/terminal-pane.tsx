import { PlaceholderPane } from './placeholder-pane'

export function TerminalPane() {
  return (
    <PlaceholderPane
      title="终端"
      description="底部：终端面板占位。"
      hints={['PTY 由 Rust 侧提供（待接）']}
    />
  )
}
