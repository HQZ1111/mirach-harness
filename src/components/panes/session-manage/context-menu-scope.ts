/**
 * 全局右键的范围裁定（main.tsx 的 contextmenu capture 监听消费的纯函数）。
 *
 * hermes app-context-menu.tsx 的 Tauri 语义裁剪：hermes 在 Electron 里从不
 * preventDefault（未处理手势由主进程原生菜单兜底），Tauri/WebView2 里
 * "默认"= WebView2 自带菜单——除可编辑区外一律 preventDefault 压掉。
 *
 * 范围（三值）：
 * - editable：输入框 / textarea / contenteditable——放行原生编辑菜单
 *   （hermes 语义：可编辑区由原生编辑面接管；harness 无桥接编辑命令，
 *   原生菜单就是正确的编辑面）；
 * - owned：自带右键菜单的面（会话行 thread-list.aui.tsx 的
 *   aui_thread-list-item-trigger 触发行 / 文件树行 WorkspaceFileTreeRowView
 *   的 role="treeitem"）——监听器必须早退且不得 preventDefault。
 *
 *   **2026-10-26 归拢后这两个面已不再用 Radix**（改成自家 beui
 *   `ContextMenu` 的落点/锚点形态，见 components/motion/context-menu.tsx），
 *   但早退语义不变：这些行自己处理 onContextMenu（preventDefault + 开菜单），
 *   全局 capture 监听若抢跑 preventDefault，行自己的 handler 会因
 *   `event.defaultPrevented` 而跳过开启——只压掉原生菜单、我们的行菜单
 *   反而不弹。登记选择器因此仍然有效且必须保留。
 * - app：其余一切——preventDefault 压掉 WebView2 菜单，再按落点分派
 *   （flexlayout tabset chrome → ZoneMenu；其余 → 窗口动词菜单）。
 *   **窗格 body（.flexlayout__tab）= app**：hermes 实锤 ZoneMenu 只包
 *   页签条/竖轨/编辑遮罩三处（tree-group.tsx 486/550/816，816 在
 *   `editMode &&` 分支里），普通模式 body 右键归 app 菜单。
 *
 * 结构化入参（closest/isContentEditable/tagName）而非 Element，node 环境
 * 单测无需 DOM（context-menu-scope.test.ts）。
 */

export interface ContextMenuScopeTarget {
  closest(selectors: string): ContextMenuScopeTarget | null
  readonly isContentEditable?: boolean
}

/** 原生编辑菜单放行面：表单字段。contenteditable 树用 DOM 的
 *  isContentEditable 属性判定（对 editable 祖先的整棵子树为 true，
 *  contenteditable="false" 的嵌套孤岛正确为 false），不走选择器。 */
export const CONTEXT_MENU_EDITABLE_SELECTOR = 'input, textarea'

/** 自带右键菜单的面（见文件头；新增右键自管面在此登记）：
 *  会话行 = thread-list.aui.tsx 的行根（`aui_thread-list-item`，2026-10-26
 *  起行根的 onContextMenu 自己开菜单）+ 行内触发器槽（历史登记，
 *  assistant-ui 的 Trigger 仍带这个 slot）；文件树行 =
 *  WorkspaceFileTreeRowView 的 role="treeitem"；机器人行 =
 *  bots-pane.tsx 的行根（`data-roster-key`，2026-11-07 机器人页移植——
 *  行与分区头都自管右键）；终端窗格 = terminal-pane.tsx 的窗格根
 *  （`data-slot="terminal-pane"`，2026-11-18 对齐 ZCode TerminalSession
 *  的右键复制/粘贴菜单）。
 *
 *  **行根必须登记**：右键落在行内边距/行尾标注上时，`closest()` 不会命中
 *  触发器槽，只命中行根——漏登记会让全局菜单抢走这一次右键。 */
export const CONTEXT_MENU_OWNER_SELECTOR =
  '[data-slot="aui_thread-list-item"], [data-slot="aui_thread-list-item-trigger"], [role="treeitem"], [data-roster-key], [data-slot="bots-pane"] [data-slot="bots-roster"] > div > div, [data-slot="terminal-pane"]'

export type ContextMenuScope = 'editable' | 'owned' | 'app'

export function resolveContextMenuScope(target: ContextMenuScopeTarget | null): ContextMenuScope {
  if (!target) return 'app'
  if (target.isContentEditable || target.closest(CONTEXT_MENU_EDITABLE_SELECTOR)) return 'editable'
  if (target.closest(CONTEXT_MENU_OWNER_SELECTOR)) return 'owned'
  return 'app'
}
