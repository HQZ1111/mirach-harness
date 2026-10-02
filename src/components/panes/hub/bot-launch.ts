/**
 * 机器人启动桥（UI 不直呼 runtime 内部——真相边界在 runtime）：
 * bots-pane 的启动钮 → pi_create_bot_session IPC（Rust 侧建会话 + 以 bot
 * 名重命名——pi 的活动 handle 已切到该会话）→ connectionBridge
 * .requestReconnect()（runtime 挂载 effect 的重连通道路由重水合——
 * refreshThreads → pi_get_state 采 sessionId → HYDRATE：既有链路原样
 * 复用，runtime.tsx 不动）。
 *
 * hermes 对应物 = bot-row 的 openRosterBot（$selectedBot.set + 主区开
 * canonical chat）；harness 的对等面 = 活动 handle 换装 + 主区水合。
 *
 * 禁止兜底：IPC 失败 console.error + 返回 null（调用方显示失败态）——
 * 不装作切换成功。
 */
import { invoke } from '@tauri-apps/api/core'

import { connectionBridge } from '@/components/assistant-ui/connection-store'

import type { BotPreset } from './bots-store'
import { splitBotModel } from './bots-store'

/** 以 bot 预设开新会话。成功返回 true（UI 已重水合）；失败 console.error
 *  返回 false（不装作成功）。 */
export async function launchBotSession(bot: BotPreset): Promise<boolean> {
  const { provider, modelId } = splitBotModel(bot.model)
  try {
    await invoke('pi_create_bot_session', {
      name: bot.name,
      // 有值才传键——无对等键的 null 直接省（pi 缺省读 settings.json）
      ...(bot.systemPrompt ? { systemPrompt: bot.systemPrompt } : {}),
      ...(provider ? { provider, modelId } : {}),
      ...(bot.cwd ? { cwd: bot.cwd } : {}),
    })
    // 活动 handle 已换——UI 重水合走 runtime 的既有重连通道（refreshThreads
    // → pi_get_state.sessionId 采纳 → HYDRATE 该会话历史）。
    connectionBridge.getState().requestReconnect()
    return true
  } catch (e) {
    console.error(`[bots] 启动机器人「${bot.name}」会话失败——保持当前会话`, e)
    return false
  }
}
