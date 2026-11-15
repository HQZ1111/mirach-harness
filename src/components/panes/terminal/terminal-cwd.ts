/**
 * 新终端的初始 cwd 选择（纯逻辑，单测覆盖）。
 *
 * 语义对齐 ZCode：终端在工作区里打开（Terminal.tsx 把 cwd 一路传到
 * terminalService.create({ cwd })）。我们的"工作区"= **当前活动会话**的
 * cwd（sessionCatalog.entries[activeId].cwd，pi SessionOptions 的
 * working_directory 投影）——终端面板是全局单例，没有自己的 workspace
 * 上下文，活动会话就是最接近 ZCode 的那份。
 *
 * 取不到（没有活动会话 / 会话没选工作区）= undefined → 宿主按系统 home
 * 开（terminal.rs【cwd 裁定】）。取到了但目录已消失 = 宿主 Err，前端
 * 显示"终端启动失败: 工作区目录不可用"（不静默换目录，规矩 12）。
 */

export interface TerminalCwdSource {
  activeId: string | null
  entries: Record<string, { cwd?: string } | undefined>
}

export function pickTerminalCwd(state: TerminalCwdSource): string | undefined {
  const activeId = state.activeId
  if (!activeId) {
    return undefined
  }
  const cwd = state.entries[activeId]?.cwd?.trim()
  return cwd ? cwd : undefined
}
