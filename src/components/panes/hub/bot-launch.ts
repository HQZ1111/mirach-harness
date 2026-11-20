/**
 * 机器人启动桥（UI 不直呼 runtime 内部——真相边界在 runtime）。
 *
 * ## 永久会话语义（hermes "one bot = one forever chat" 宿主对偶）
 *
 * hermes：一个 bot = 一个 profile = 一条永久 "Bot Chat" 会话（隐藏于会话
 * 列表，花名册是唯一入口）。**pi 的承载事实**（vendor 源码核对，
 * session_index.rs init_schema）：sessions 表只有 `path TEXT PRIMARY KEY`，
 * **name 无唯一索引**；也没有会话级 hidden 面——hermes 那两个依赖在 pi
 * 都不存在。宿主的对偶实现（不改引擎）：
 *
 * 1. **锚定用 sessionId 不用名字**：`pi_create_bot_session` 返回 pi 状态
 *    快照（main.rs:827，含 sessionId）——直接采纳；文件路径从
 *    `pi_list_sessions` 按 **id** 匹配（id = 文件 header 身份，天然唯一；
 *    名字匹配会撞同名会话，v1 实现的缺陷，已废）。
 * 2. **再启**（chatSessionPath 非空）→ `pi_open_session`（返回
 *    "provider/model" 仅供日志，sessionId 走 `pi_get_state`——runtime.tsx
 *    回到父会话同款先例）→ **身份校验**：state.sessionId ≠ 已锚 id =
 *    路径内容已不是这个 bot 的会话（旧记录误配/文件被换）——console.error
 *    可见后清锚重建；无锚旧记录借此完成首校锚定。
 * 3. **会话列表隐藏**：pi 无 hidden 面，隐藏做在**前端显示层**——
 *    `bots-store.botChatPaths()`（双锚记录的 path 集）由 thread-list 的
 *    行投影过滤（花名册是唯一入口）。旧名字匹配记录在重新锚定前不参与
 *    隐藏（防误藏同名用户会话）。
 *
 * 多环境：connectionId 非 local 的 bot 启动为**假面**（pi 无远端 gateway）。
 *
 * 禁止兜底：IPC 失败 console.error + 返回 null/false（调用方显示失败态）
 * ——不装作切换成功；锚记录不全不猜路径（名字匹配正是要废掉的歧义源）。
 */
import { invoke } from '@tauri-apps/api/core'

import { connectionBridge } from '@/components/assistant-ui/connection-store'
import { sessionPreviewBridge } from '@/components/assistant-ui/session-preview-bridge'

import type { BotPreset } from './bots-store'
import { botsStore, splitBotModel } from './bots-store'

/** pi_list_sessions 行（id = 文件 header id；path = 索引主键）。 */
interface PiSessionRow {
  id: string
  name: null | string
  path: string
}

/** pi 状态快照里本桥消费的字段（pi_get_state / pi_create_bot_session）。 */
interface PiStateSnapshot {
  sessionId: string | null
}

/** 按 sessionId 从 pi_list_sessions 找会话文件路径（id = header 身份，
 *  无歧义——name 无唯一索引，按名找会撞同名会话）。 */
async function findPathBySessionId(sessionId: string): Promise<string | null> {
  try {
    const sessions = await invoke<PiSessionRow[]>('pi_list_sessions')
    return sessions.find((s) => s.id === sessionId)?.path ?? null
  } catch (e) {
    console.error('[bots] 会话清单查询失败', e)
    return null
  }
}

/** bot 预设的技能注入（hermes profile.skills 对偶）：pi 无 per-session
 *  技能注入面（skills_prompt 是进程级宿主渲染），bot 级技能 = 拼进
 *  system prompt 交给 pi（SessionOptions.system_prompt 的追加段，模型
 *  可见、可执行——真效果，不是 UI 装饰）。 */
function composeSystemPrompt(bot: BotPreset, mcpConfigPath: null | string): string {
  const base = bot.systemPrompt.trim()
  const blocks: string[] = []
  const skills = (bot.skills ?? []).filter((s) => s.trim() !== '')
  if (skills.length > 0) {
    blocks.push(
      `# Skills\nThe following skills are attached to this agent. When a task matches, invoke them (slash form in prompts): ${skills.map((s) => `/${s}`).join(', ')}`,
    )
  }
  if (mcpConfigPath) {
    const servers = (bot.mcpServers ?? []).filter((s) => s.trim() !== '')
    blocks.push(
      `# MCP\nThis bot may use only the MCP servers in this configuration file: ${mcpConfigPath} (servers: ${servers.join(', ')}). Call mcp_list / mcp_call / mcp_resource with configPath="${mcpConfigPath}". Do not use any other MCP configuration.`,
    )
  }
  return [base, ...blocks].filter(Boolean).join('\n\n')
}

/** per-bot MCP 配置文件（rpi-mcp-adapter 的 configPath 面，真生效）：
 *  所选服务器从全局 mcp.json 过滤后写到 ~/.rpi/agent/bot-mcp/<bot>.json；
 *  未选（undefined/空）= 不生成、不注入（宿主不过滤全局 mcp 工具，故为空时
 *  模型仍可能自行使用全局配置——UI 文案如实标注）。 */
async function composeMcpConfigPath(bot: BotPreset): Promise<null | string> {
  const servers = (bot.mcpServers ?? []).filter((s) => s.trim() !== '')
  if (servers.length === 0) return null
  const res = await invoke<{ path: string }>('pi_bot_mcp_config', {
    botName: bot.name,
    servers,
  })
  return res.path
}

/** bot 预设的工具集 → enabled_tools 名单（hermes profile toolsets 对偶，
 *  真生效：pi_create_bot_session → SessionOptions.enabled_tools）。
 *  未选任何组 = null（pi 默认集/全局偏好）。所选组从 pi_capabilities 的
 *  toolsets 映射为工具名并集；目录读失败 = 传播（规矩 12——用户明确选了
 *  能力面，静默降级成默认集会造假）。 */
async function composeEnabledTools(bot: BotPreset): Promise<string[] | null> {
  const keys = (bot.toolsets ?? []).filter((s) => s.trim() !== '')
  if (keys.length === 0) return null
  const caps = await invoke<{
    toolsets: { key: string; tools: string[] }[]
  }>('pi_capabilities')
  const set = new Set<string>()
  for (const ts of caps.toolsets) {
    if (!keys.includes(ts.key)) continue
    for (const tool of ts.tools) set.add(tool)
  }
  if (set.size === 0) {
    throw new Error(`所选工具集 ${keys.join(', ')} 在 pi_capabilities 中无工具`)
  }
  return [...set]
}

/** 打开 bot 的永久会话（存在 → 校验身份后复用；不存在 → 创建并双锚记录）。 */
async function openOrCreate(bot: BotPreset): Promise<boolean> {
  const { provider, modelId } = splitBotModel(bot.model)
  if (bot.chatSessionPath) {
    // 秒开：先投递「不打开引擎的尾部预览」，runtime 立即把该 bot 会话画
    // 出来；下面的 pi_open_session（巨会话数秒）在后台继续，完成后
    // reconnect 效果统一对齐。身份双锚不全时只按路径预览（防旧记录误挂）。
    if (bot.chatSessionId) {
      sessionPreviewBridge
        .getState()
        .requestPreview(bot.chatSessionPath, bot.chatSessionId)
    }
    try {
      await invoke('pi_open_session', { path: bot.chatSessionPath })
      // pi_open_session 返回 "provider/model"（仅供日志）——身份走
      // pi_get_state（runtime.tsx「回到父会话」同款先例）。
      const st = await invoke<PiStateSnapshot>('pi_get_state')
      const sid = st?.sessionId ?? null
      if (bot.chatSessionId && sid && sid !== bot.chatSessionId) {
        // 路径内容不再是这个 bot 的会话（同名误配旧记录 / 文件被换）——
        // 可见报错后清锚重建，不装作打开成功。
        console.error(
          `[bots] 永久会话身份不符（${sid} ≠ 锚 ${bot.chatSessionId}）——清锚重建`,
        )
        botsStore
          .getState()
          .patchMeta(bot.name, { chatSessionPath: null, chatSessionId: null })
      } else {
        if (!bot.chatSessionId && sid) {
          // 旧名字匹配记录的无锚路径——借此完成首校锚定。
          botsStore.getState().patchMeta(bot.name, { chatSessionId: sid })
        }
        connectionBridge.getState().requestReconnect()
        return true
      }
    } catch (e) {
      // 会话文件可能被手动删除——退回创建（路径清空重新走首启）
      console.error(`[bots] 永久会话打开失败（退回创建）`, e)
      botsStore
        .getState()
        .patchMeta(bot.name, { chatSessionPath: null, chatSessionId: null })
    }
  }
  // 首启：创建新会话
  try {
    const mcpConfigPath = await composeMcpConfigPath(bot)
    const systemPrompt = composeSystemPrompt(bot, mcpConfigPath)
    const enabledTools = await composeEnabledTools(bot)
    const st = await invoke<PiStateSnapshot>('pi_create_bot_session', {
      name: bot.name,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(provider ? { provider, modelId } : {}),
      ...(bot.cwd ? { cwd: bot.cwd } : {}),
      ...(enabledTools ? { enabledTools } : {}),
      ...(bot.extensions?.length ? { extensionFilter: bot.extensions } : {}),
    })
    const sid = st?.sessionId ?? null
    if (sid) {
      const path = await findPathBySessionId(sid)
      if (path) {
        botsStore.getState().patchMeta(bot.name, { chatSessionPath: path, chatSessionId: sid })
      } else {
        // 会话已建并激活（真话），但 pi_list_sessions 里没有这个 id——
        // 不猜路径（名字匹配是已废的歧义源），锚记录不全的后果（下次
        // 启动再建一条）如实发生，错误可见。
        console.error(`[bots] 会话 ${sid} 不在 pi_list_sessions——永久会话锚未记录`)
        botsStore.getState().patchMeta(bot.name, { chatSessionId: sid })
      }
    } else {
      console.error('[bots] pi_create_bot_session 未返回 sessionId——永久会话锚未记录')
    }
    connectionBridge.getState().requestReconnect()
    return true
  } catch (e) {
    console.error(`[bots] 启动机器人「${bot.name}」会话失败——保持当前会话`, e)
    return false
  }
}

/** 打开 bot（hermes openRosterBot 宿主对偶）。
 *  多环境：connectionId 非 local 的 bot 启动为**假面**（pi 无远端
 *  gateway），返回 false 让 UI 红显。 */
export async function launchBotSession(bot: BotPreset): Promise<boolean> {
  if (bot.connectionId && bot.connectionId !== 'local') {
    console.error(
      `[bots] 机器人「${bot.name}」归属远端连接 ${bot.connectionId}——远端 gateway 未接通（占位）`,
    )
    return false
  }
  return openOrCreate(bot)
}

/** 与此机器人开新聊天（hermes newBotChat 对偶：另起一条普通会话，
 *  不动永久会话）。 */
export async function newBotChat(bot: BotPreset): Promise<boolean> {
  const { provider, modelId } = splitBotModel(bot.model)
  try {
    const mcpConfigPath = await composeMcpConfigPath(bot)
    const systemPrompt = composeSystemPrompt(bot, mcpConfigPath)
    const enabledTools = await composeEnabledTools(bot)
    await invoke('pi_create_bot_session', {
      name: `${bot.name} · ${new Date().toLocaleDateString()}`,
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(provider ? { provider, modelId } : {}),
      ...(bot.cwd ? { cwd: bot.cwd } : {}),
      ...(enabledTools ? { enabledTools } : {}),
    })
    connectionBridge.getState().requestReconnect()
    return true
  } catch (e) {
    console.error(`[bots] 与「${bot.name}」开新聊天失败`, e)
    return false
  }
}
