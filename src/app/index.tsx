/**
 * 主窗根。窗口分派（main.tsx 的 ?win= 参数）落点：
 *   - 默认 → 本文件 App（主窗壳：app/shell/）
 *   - ?win=quick → app/quick-entry/（骨架已建，待接）
 *   - ?win=hud   → app/hud/（骨架已建，待接）
 */

import { FlexLayoutShell } from '@/components/layout/flex-layout'

export function App() {
  return <FlexLayoutShell />
}
