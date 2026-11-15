/**
 * 终端页签的纯逻辑小件（无 React/无 IPC——单测覆盖）：
 * 页签标题 = 项目名 + 序号（ZCode Terminal.tsx 的 projectName/index 语义，
 * 纯函数与 terminalPanelState.formatTerminalTabTitle /
 * getNextTerminalSessionIndex 同源）。
 *
 * 为什么不拿 shell 名做标题：同一工作区里开三个页签全是 "PowerShell"，
 * 页签条无法区分；ZCode 的语义是"项目名 + 第几个"（"repo"、"repo 2"），
 * shell 名放在悬停提示里。
 */

/** cwd → 项目名（末段；Windows/Unix 两种斜杠都吃）。空/根 = null。 */
export function terminalProjectName(cwd: string | null | undefined): string | null {
  const trimmed = cwd?.trim()
  if (!trimmed) {
    return null
  }
  const parts = trimmed.split(/[\\/]/).filter((part) => part.length > 0)
  const leaf = parts[parts.length - 1]
  return leaf ? leaf : null
}

/** 页签名：第 1 个不带序号，之后 "项目名 N"（ZCode 逐字同源）。 */
export function formatTerminalTabTitle(projectName: string, index: number): string {
  return index > 1 ? `${projectName} ${index}` : projectName
}

/** 下一个页签序号 = 现存序号里最小的空位（关掉 2 号后新建仍得 2）。 */
export function nextTerminalIndex(used: readonly number[]): number {
  const taken = new Set(used)
  for (let index = 1; ; index += 1) {
    if (!taken.has(index)) {
      return index
    }
  }
}
