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
 * - owned：自带 Radix ContextMenu 的面（会话行 thread-list.aui.tsx 的
 *   aui_thread-list-item-trigger 触发行 / 文件树行 WorkspaceFileTreeRowView
 *   的 role="treeitem"）——监听器必须早退且不得 preventDefault：Radix
 *   ContextMenuTrigger 的开启分支走 composeEventHandlers 的
 *   defaultPrevented 检查，事件带着 defaultPrevented=true 到达时它会跳过
 *   开启（只压掉原生菜单、我们的 SessionContextMenu 反而不弹）。Radix
 *   自己的 handler 会打开菜单并 preventDefault 压原生菜单（CDP 实测：
 *   行右键 defaultPrevented=true、菜单 5 项）。
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

/** 自带 Radix ContextMenu 的面（见文件头；新增右键自管面在此登记）：
 *  会话行 = assistant-ui thread-list 行触发器（thread-list.aui.tsx
 *  ContextMenuPrimitive.Trigger asChild 包行；2026-10-02 dnd-kit 化后行上
 *  已无 data-session-row-id，实测全仓 0 处生产者——登记现役 slot）；
 *  文件树行 = WorkspaceFileTreeRowView 的 role="treeitem"。 */
export const CONTEXT_MENU_OWNER_SELECTOR = '[data-slot="aui_thread-list-item-trigger"], [role="treeitem"]'

export type ContextMenuScope = 'editable' | 'owned' | 'app'

export function resolveContextMenuScope(target: ContextMenuScopeTarget | null): ContextMenuScope {
  if (!target) return 'app'
  if (target.isContentEditable || target.closest(CONTEXT_MENU_EDITABLE_SELECTOR)) return 'editable'
  if (target.closest(CONTEXT_MENU_OWNER_SELECTOR)) return 'owned'
  return 'app'
}
