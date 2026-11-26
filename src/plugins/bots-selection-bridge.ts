/**
 * 环境切换 → 机器人页选中联动（2026-11-26 用户："选择环境，机器人页没跟"）。
 *
 * 环境菜单 / 配置档案栏 / 会话打开触发的活动环境变化，都要让 hermes-bots
 * 花名册把对应 bot 行选中（`$selectedRosterKey`）。宿主与插件之间用
 * 一个窗口事件解耦：插件可关闭，关闭时事件无人接收（无副作用）。
 * profile = null/空 = 本体 → 选中 default（Mirach）行。
 */
export const BOTS_SELECT_EVENT = 'mirach:bots:select'

export interface BotsSelectDetail {
  profile: null | string
}

export function selectBotsRoster(profile: null | string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent<BotsSelectDetail>(BOTS_SELECT_EVENT, {
      detail: { profile: profile && profile.length > 0 ? profile : null },
    }),
  )
}
