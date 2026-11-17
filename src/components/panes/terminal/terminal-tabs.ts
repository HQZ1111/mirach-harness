/**
 * 终端标签的纯逻辑小件（无 React/无 IPC——单测覆盖）。
 *
 * 2026-11-17 对齐 ZCode 侧栏终端：一个终端 = 一个面板栏标签，标题 = cwd
 * 末段 + 序号（ZCode `useAppPanels.createTerminalSidePaneTitle` 同源），
 * 面板 id 与标题分别取最小空位（`docs/ui/side-pane-terminal-tabs.md`）。
 *
 * 为什么不拿 shell 名做标题：同一工作区里开三个终端全是 "PowerShell"，
 * 标签条无法区分；ZCode 的语义是"项目名 + 第几个"（"repo"、"repo 2"）。
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

/**
 * 下个终端面板标题（ZCode `useAppPanels.createTerminalSidePaneTitle` 同源）：
 * 基础名没被占用就用基础名；否则取第一个空位 "基础名 2"、"基础名 3"。
 */
export function nextTerminalPanelTitle(
  baseTitle: string,
  usedTitles: ReadonlySet<string>,
): string {
  if (!usedTitles.has(baseTitle)) {
    return baseTitle
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${baseTitle} ${index}`
    if (!usedTitles.has(candidate)) {
      return candidate
    }
  }
}

/**
 * 下个终端面板 id：`terminal` / `terminal-2` / `terminal-3`（最小空位）。
 * dockview 的面板 id 必须唯一；标题与 id 分开算（同 ZCode：标题按名去重，
 * 关闭中间标签后标题不重排）。
 */
export function nextTerminalPanelId(usedIds: readonly string[]): string {
  const taken = new Set(usedIds)
  if (!taken.has('terminal')) {
    return 'terminal'
  }
  for (let index = 2; ; index += 1) {
    const id = `terminal-${index}`
    if (!taken.has(id)) {
      return id
    }
  }
}

/** 面板 id 是否属于终端域（关标签的栏生命周期判定用）。 */
export function isTerminalPanelId(panelId: string): boolean {
  return panelId === 'terminal' || /^terminal-\d+$/.test(panelId)
}

