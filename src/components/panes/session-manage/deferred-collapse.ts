/**
 * 分组开关（会话侧栏的段头/日期桶/工作区桶/状态桶共用入口）。
 *
 * **2026-11-25 用户定稿："折叠和打开选项的动画组件，就是慢慢展开的那个，
 * 删除改回默认的。"** 自 2026-10-18 起的延迟提交 + 逐行入场/退场动画
 * （`deferred-collapse` 计时器 + `.disclose-row` / `.disclose-row--closing`
 * 关键帧）已整体删除：点击组头 = 立刻写 `groupsCollapsed`，行随数据管线
 * 同步挂载/卸载，无动画（默认行为）。
 *
 * 入口保留 `requestGroupToggle` 一个函数（四个分组头是独立组件，共用同名
 * 动作；调用方不必知道自己拿的是 store 还是动画层）。
 */
import { sessionCatalog } from './session-catalog'

/** 分组头的统一开关：立即提交（无延迟、无动画）。 */
export const requestGroupToggle = (key: string, collapsed: boolean): void => {
  sessionCatalog.getState().setGroupCollapsed(key, collapsed)
}
