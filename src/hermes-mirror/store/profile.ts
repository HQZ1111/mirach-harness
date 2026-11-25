/**
 * profile（hermes `store/profile.ts` 的对偶——2026-11-25 校正：宿主已有多
 * 配置档案（每个 bot = 一个具名 profile / 完整 home）与多网关连接，不再是
 * "单身份"。上游 1,222 行里宿主暂时只需要这几个导出的**真实投影**：
 *
 * - `$profiles`：本机名册 = 本体（default，产品名显示在 UI 层）+ botsStore
 *   里的每个具名档案（default 行合并为 is_default 一条）。订阅 botsStore，
 *   增删/改名即时反映（上游 `refreshProfiles` 的进程内对偶）。
 * - `prewarmProfileBackend`：上游预热**后端进程池 + socket**；宿主是单进程
 *   引擎，等价的真实动作 = 备好该 profile 的 home 目录与种子配置
 *   （Rust `pi_profile_ensure`，copy-if-missing）——失败只可见不抛出
 *   （预热是后台动作，调用方的真实路径会自己报错，上游同款纪律）。
 *
 * 远程（其它连接上的）profile 不在这里枚举：那是各连接的 profiles.list，
 * 由 roster（host.agents）按连接合并——`$profiles` 与上游一样只描述**当前
 * 本机网关**的档案。
 */
import { atom } from 'nanostores'

import { botsStore } from '@/components/panes/hub/bots-store'

export interface HermesProfileEntry {
  id: string
  name: string
  isDefault?: boolean
}

/** 本机 profile 名册（default 恒第一；具名按 botsStore 顺序）。 */
export const $profiles = atom<HermesProfileEntry[]>([{ id: 'default', name: 'default', isDefault: true }])

function projectProfiles(): HermesProfileEntry[] {
  const bots = botsStore.getState().bots
  const named = bots.filter((bot) => bot.name && bot.name !== 'default')
  return [
    { id: 'default', name: 'default', isDefault: true },
    ...named.map((bot) => ({ id: bot.name, name: bot.name })),
  ]
}

function syncProfiles(): void {
  const next = projectProfiles()
  const prev = $profiles.get()
  const same =
    prev.length === next.length &&
    prev.every((entry, index) => entry.name === next[index]?.name && entry.isDefault === next[index]?.isDefault)
  if (!same) $profiles.set(next)
}

// botsStore 是懒加载的（机器人页/花名册首次挂载时 load）——订阅后随加载/
// 增删自动同步；这里不主动 load（避免在只想读名册的插件路径上拉起整仓）。
botsStore.subscribe(syncProfiles)
syncProfiles()

/** 宿主不需要的导出（上游有、调用点为 0——保持最小面，防止误用）。 */

/** 预热 profile 后端：宿主对偶 = 备好该 profile 的 home 与种子配置。
 *  失败 console.error 可见、不抛出（后台预热；真实会话路径会自己报错）。 */
export async function prewarmProfileBackend(profile?: null | string): Promise<void> {
  const name = (profile ?? '').trim()
  if (!name || name === 'default') return
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('pi_profile_ensure', { name })
  } catch (e) {
    console.error(`[profile] prewarmProfileBackend(${name}) 失败`, e)
  }
}
