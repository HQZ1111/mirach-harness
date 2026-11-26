/**
 * 配置档案偏好（hermes `$profileColors` / `$profileOrder` 的宿主对偶，
 * 2026-11-26）。旧 `$profileRailVisible` 显隐开关随横向档案栏一起退休
 * （档案切换器现在就是左栏底部的身份行，常驻）。
 *
 * - colors：用户给具名档案挑的颜色覆盖（`mirach.harness.profileRailColors.v1`）；
 *   删键 = 回确定性色相；
 * - order：档案列表拖拽顺序（`mirach.harness.profileRailOrder.v1`）。
 */
import { createStore, useStore } from 'zustand'

export const PROFILE_RAIL_COLORS_KEY = 'mirach.harness.profileRailColors.v1'
export const PROFILE_RAIL_ORDER_KEY = 'mirach.harness.profileRailOrder.v1'

// ── 档案色覆盖（hermes $profileColors）────────────────────────────────────

function parseColorOverrides(raw: string | null): Record<string, string> {
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      console.error('[profile-rail] 颜色存储形状非法——按空表起步', parsed)
      return {}
    }
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) out[key] = value
    }
    return out
  } catch (e) {
    console.error('[profile-rail] 颜色存储解析失败——按空表起步（原值保留）', e)
    return {}
  }
}

export const profileRailColorsStore = createStore<{ colors: Record<string, string> }>(() => ({
  colors: parseColorOverrides(localStorage.getItem(PROFILE_RAIL_COLORS_KEY)),
}))

export const useProfileRailColors = (): Record<string, string> =>
  useStore(profileRailColorsStore, (s) => s.colors)

/** 设置/清除一个具名档案的颜色（null = 回自动色相）。 */
export function setProfileRailColor(name: string, color: null | string): void {
  const key = name.trim()
  if (!key || key === 'default') return
  const next = { ...profileRailColorsStore.getState().colors }
  if (color && color.trim()) next[key] = color
  else delete next[key]
  profileRailColorsStore.setState({ colors: next })
  try {
    localStorage.setItem(PROFILE_RAIL_COLORS_KEY, JSON.stringify(next))
  } catch (e) {
    console.error('[profile-rail] 持久化档案颜色失败（本次会话内有效）', e)
  }
}

// ── 档案顺序（hermes $profileOrder）──────────────────────────────────────

function parseOrder(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      console.error('[profile-rail] 顺序存储形状非法——按花名册顺序', parsed)
      return []
    }
    return parsed.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
  } catch (e) {
    console.error('[profile-rail] 顺序存储解析失败——按花名册顺序（原值保留）', e)
    return []
  }
}

export const profileRailOrderStore = createStore<{ order: string[] }>(() => ({
  order: parseOrder(localStorage.getItem(PROFILE_RAIL_ORDER_KEY)),
}))

export const useProfileRailOrder = (): string[] =>
  useStore(profileRailOrderStore, (s) => s.order)

export function setProfileRailOrder(order: readonly string[]): void {
  const next = order.map((name) => name.trim()).filter(Boolean)
  profileRailOrderStore.setState({ order: next })
  try {
    localStorage.setItem(PROFILE_RAIL_ORDER_KEY, JSON.stringify(next))
  } catch (e) {
    console.error('[profile-rail] 持久化档案顺序失败（本次会话内有效）', e)
  }
}

/** 档案改名后迁移颜色/顺序偏好（hermes rename 的本地偏好对偶）。 */
export function renameProfileRailPrefs(from: string, to: string): void {
  const oldName = from.trim()
  const newName = to.trim()
  if (!oldName || !newName || oldName === newName) return
  const colors = profileRailColorsStore.getState().colors
  if (Object.prototype.hasOwnProperty.call(colors, oldName)) {
    setProfileRailColor(newName, colors[oldName] ?? null)
    setProfileRailColor(oldName, null)
  }
  if (profileRailOrderStore.getState().order.includes(oldName)) {
    setProfileRailOrder(
      profileRailOrderStore.getState().order.map((name) => (name === oldName ? newName : name)),
    )
  }
}
