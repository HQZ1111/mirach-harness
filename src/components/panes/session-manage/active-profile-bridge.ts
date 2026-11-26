/**
 * 环境（profile）切换 bridge（2026-11-22）——hermes Desktop「配置档案」
 * 切换的宿主对偶：本地 bot = 一个环境（独立 home + 独立会话面），切环境时
 * 引擎侧 `pi_profile_set_active` 改活动 home，`pi_list_sessions` 随之只列
 * 出该环境的会话（见 `src-tauri/src/pi_profiles.rs`）。
 *
 * 分层：本模块持**持久化 + UI 投影 + 注册口**；真正的切换动作（改引擎状态
 * → 丢弃当前前台会话 → 清运行态 → 重拉列表）由 runtime 注册进来——切环境
 * 要动 actor/尾页/目录活动，只有 runtime 有那些入口（与 session-tab-bridge
 * 同一登记模式）。
 */
import { createStore, useStore } from 'zustand'

export const ACTIVE_PROFILE_KEY = 'mirach.harness.activeProfile.v1'

export type ProfileSwitcher = (profile: null | string) => Promise<boolean>

let switcher: ProfileSwitcher | null = null

/** 轻量跟随器（不拆会话）：打开某环境的会话/机器人会话时把该环境设为
 *  活动环境（侧栏随之换源）。与显式切换的区别 = 不 discard 当前会话，
 *  打开动作自己会换前台。runtime 挂载时注册。 */
let follower: ProfileSwitcher | null = null

/** 新聊天草稿请求（不切环境）：`host.newChat` 的 bots 草稿路径用。runtime
 *  挂载时注册；动作 = 丢当前会话 + RESET，但不改活动 profile。 */
type DraftRequester = () => Promise<boolean>
let draftRequester: DraftRequester | null = null

/** runtime 挂载时注册（卸载清空；未注册 = 错误可见，规矩 12）。 */
export function setProfileSwitcher(fn: ProfileSwitcher | null) {
  switcher = fn
}

export function setProfileFollower(fn: ProfileSwitcher | null) {
  follower = fn
}

export function setNewChatDraftRequester(fn: DraftRequester | null) {
  draftRequester = fn
}

/** 丢当前会话并回到 New Chat 草稿（活动环境保持不变）。 */
export function requestNewChatDraftBridge(): Promise<boolean> {
  if (!draftRequester) {
    console.error('[active-profile] 草稿请求器未注册（runtime 未挂载）——未回到 New Chat')
    return Promise.resolve(false)
  }
  return draftRequester()
}

/** 切换活动环境；返回 false = 失败（引擎未切换，调用方不得按成功继续）。 */
export function switchProfileBridge(profile: null | string): Promise<boolean> {
  if (!switcher) {
    console.error('[active-profile] 切换器未注册（runtime 未挂载）——环境未切换')
    return Promise.resolve(false)
  }
  return switcher(profile)
}

/** 跟随活动环境（打开会话/点机器人时用）：只改引擎活动 home + UI 投影，
 *  不打断当前会话。未注册 = 错误可见。 */
export function followProfileBridge(profile: null | string): Promise<boolean> {
  if (!follower) {
    console.error('[active-profile] 跟随器未注册（runtime 未挂载）——环境未跟随')
    return Promise.resolve(false)
  }
  return follower(profile)
}

export function readPersistedProfile(): null | string {
  try {
    const raw = localStorage.getItem(ACTIVE_PROFILE_KEY)
    return raw && raw !== 'null' ? raw : null
  } catch (e) {
    console.error('[active-profile] 读取失败（按本体起）', e)
    return null
  }
}

export function persistProfile(profile: null | string): void {
  try {
    localStorage.setItem(ACTIVE_PROFILE_KEY, profile ?? 'null')
  } catch (e) {
    console.error('[active-profile] 持久化失败（本次会话内有效）', e)
  }
}

/** UI 投影（菜单/标签订阅；真相以引擎活动环境为准，切换成功后同步）。 */
export const profileStore = createStore<{ profile: null | string }>(() => ({
  profile: readPersistedProfile(),
}))

export const useActiveProfile = (): null | string => useStore(profileStore, (s) => s.profile)

export function setActiveProfileLocal(profile: null | string): void {
  profileStore.setState({ profile })
  persistProfile(profile)
}
