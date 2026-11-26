/**
 * 菜单 portal 的归属判定（纯函数，2026-11-25）。
 *
 * 子菜单是**兄弟 portal**（各自挂在 body 下），但 React 组件树里是父菜单
 * Content 的后代。父菜单的 window-capture `pointerdown` 外部点击判定若只
 * 认"本菜单 + 祖先菜单"的 `data-menu-portal` id，会看不见子菜单 portal →
 * 点二级项时父菜单先卸载整棵树，`pointerup/click` 到不了按钮（用户实报
 * "左侧栏的分组选项全部不能点"）。
 *
 * 判据：每个 portal 用 `data-menu-ancestors` 记录自己的**祖先菜单 id 链**
 * （`|` 分隔，根菜单为空串）；目标最近的 portal 的祖先链含本菜单 id =
 * 本菜单的后代 → 内部点击，不关。
 */
export function menuPortalDescendsFrom(
  ancestors: null | string | undefined,
  menuId: string,
): boolean {
  if (!ancestors) return false
  return ancestors.split('|').includes(menuId)
}
