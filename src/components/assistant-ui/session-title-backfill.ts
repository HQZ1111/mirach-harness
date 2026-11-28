/**
 * 历史会话标题回填（hermes「服务端建会话即命名」的宿主对偶）。
 *
 * 为什么需要：pi 的会话名只有 `set_name` 写过才存在；宿主旧版的自动命名
 * （runtime 的 maybeAutoNameSession）只在 **POST 成功**后触发一次，且对
 * 尾页水合（hasMore）的会话主动跳过——于是历史里大量未命名会话在侧栏
 * 回落 "New Chat"（2026-11-28 用户："刚打开软件左侧栏的会话名还是会显示
 * 新会话"）。
 *
 * 本模块在启动后对**非活动**的未命名会话批量补标题：
 *   1. Rust `pi_session_first_user(path)` 读文件首条 user 文本（与前端
 *      firstUserMessageText 同判据，只认 entry/message/role=user）；
 *   2. `deriveTitle` 即时标题（hermes derive_title 对标，无模型）；
 *   3. `pi_session_rename_at_path` 落名——**durable**：写进会话文件，
 *      pi TUI / 下次启动 / 其它读取方全部认这份名字（不是显示层补丁）。
 *
 * 边界（如实，不兜底）：
 * - 只处理 piName 为空的行。"Bot Chat" / 档案名污染是显示层的降级判据
 *   （sessionDisplayName），不在这里改写——Bot Chat 是管道会话的隐藏锚，
 *   改名会让它露进侧栏。
 * - 活动会话跳过（引擎 live 柄持有 writer lease；该会话由
 *   maybeAutoNameSession 在 POST 后命名，或用户手动重命名）。
 * - 每次启动上限 MAX_PER_RUN 条（最近修改优先）；逐条失败 =
 *   console.error 并继续，下次启动重试（attempted 只在本次运行内记忆）。
 * - 与 maybeAutoNameSession 一样受 titling.auto_title 配置门约束吗？
 *   不——那条门管的是"发消息时自动命名"的时机偏好；这里是把**已经存在的
 *   无名会话**补上标题（hermes 里建会话就有标题，不存在"关掉开关后历史
 *   会话全部变 New Chat"的形态）。开关关掉只是不再对新消息自动命名。
 */
import { invoke } from '@tauri-apps/api/core'

import { sessionCatalog } from '@/components/panes/session-manage/session-catalog'
import { deriveTitle, nextTitleInLineage } from './session-title'

/** 每次启动的回填上限（最近修改优先；剩下留给下次启动）。 */
export const MAX_PER_RUN = 12

let running = false
const attempted = new Set<string>()

export interface TitleBackfillResult {
  /** 本次成功落名的会话数（供调用方决定是否 refreshThreads）。 */
  renamed: number
}

/**
 * 给回填一个**启动预算**：超时即放行启动页（后台继续跑完，attempted/落名
 * 由后续 refreshThreads 收口）。用于启动链 gating——hermes 的会话标题来自
 * 网关会话列表（建会话即有名），宿主在启动页阶段补等效事实，不能让启动
 * 无限等（大文件 load 重放可能秒级）。
 */
export function withBackfillBudget<T>(work: Promise<T>, budgetMs: number): Promise<T | null> {
  return Promise.race([
    work,
    new Promise<null>((resolve) => {
      window.setTimeout(() => resolve(null), budgetMs)
    }),
  ])
}

export interface TitleBackfillOptions {
  /** 额外排除的会话 id（例如启动恢复的会话——引擎 live 柄持有 writer
   *  lease，改它走 pi_rename_session/手动重命名）。 */
  excludeIds?: readonly string[]
}

/**
 * 焦点会话的标题补齐（**该用 live 改名**：它正是引擎当前句柄，走
 * `pi_rename_session`，不碰文件 lease）。
 *
 * 为什么单列：批量回填把活动会话排除在外（写盘会撞 lease），但用户最常
 * 看到的就是启动恢复的那个会话——2026-11-28 实机复现："刚打开左侧栏的
 * 会话名还是会显示新会话"指的就是它（恢复的会话没有 POST，maybeAutoName
 * 不会触发；尾页水合时 derivedTitle 也常常算不出）。
 *
 * 与 maybeAutoNameSession 的差异：标题原料来自**文件头**首条 user 消息
 * （`pi_session_first_user`），不是水合后的消息页——所以尾页模式（hasMore）
 * 也能正确命名，没有那条跳过规则。
 *
 * 只处理空名（Bot Chat/档案名污染是显示层降级，见 backfillSessionTitles
 * 头注）。返回是否真的落了名（调用方 refreshThreads）。
 */
export async function nameFocusedSessionIfUnnamed(sessionId: string): Promise<boolean> {
  const entry = sessionCatalog.getState().entries[sessionId]
  if (!entry) return false
  if ((entry.piName ?? '').trim().length > 0) return false
  const path = entry.path
  if (!path) return false
  if (attempted.has(path)) return false
  attempted.add(path)
  try {
    const text = await invoke<string | null>('pi_session_first_user', { path })
    if (!text) return false
    const derived = deriveTitle(text)
    if (!derived) return false
    const existingTitles: string[] = Object.values(sessionCatalog.getState().entries)
      .map((e) => e.piName)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)
    const title = nextTitleInLineage(derived, existingTitles)
    // 先落显示层（落名失败也不停 New Chat），再走 live 改名。
    sessionCatalog.getState().setDerivedTitle(sessionId, title)
    await invoke('pi_rename_session', { name: title })
    return true
  } catch (e) {
    console.error('[session-title] 焦点会话标题补齐失败（保持默认名）', sessionId, e)
    return false
  }
}

/**
 * 启动后调用一次（refreshThreads 首次成功后）。返回本次落名数；调用方
 * 在 >0 时再 refreshThreads() 让侧栏拿到新名字。
 */
export async function backfillSessionTitles(
  options: TitleBackfillOptions = {},
): Promise<TitleBackfillResult> {
  if (running) return { renamed: 0 }
  running = true
  let renamed = 0
  try {
    const excluded = new Set(options.excludeIds ?? [])
    const state = sessionCatalog.getState()
    const activeId = state.activeId
    const candidates = Object.values(state.entries)
      .filter((entry) => {
        if (!entry.path) return false
        if (entry.id === activeId) return false
        if (excluded.has(entry.id)) return false
        if ((entry.piName ?? '').trim().length > 0) return false
        if (attempted.has(entry.path)) return false
        return true
      })
      .sort((a, b) => (b.lastModifiedMs ?? 0) - (a.lastModifiedMs ?? 0))
      .slice(0, MAX_PER_RUN)
    if (candidates.length === 0) return { renamed: 0 }

    // 谱系编号原料：目录里已有的 pi 名 + 本次已落的标题（撞名追加 #N）。
    const existingTitles: string[] = Object.values(state.entries)
      .map((entry) => entry.piName)
      .filter((name): name is string => typeof name === 'string' && name.length > 0)

    for (const entry of candidates) {
      const path = entry.path
      if (!path) continue
      attempted.add(path)
      try {
        const text = await invoke<string | null>('pi_session_first_user', { path })
        if (!text) continue // 无 user 文本（空会话/被截断）——保持未命名
        const derived = deriveTitle(text)
        if (!derived) continue
        const title = nextTitleInLineage(derived, existingTitles)
        // 先落**显示层**派生标题：即使落名失败（例如句柄在场的会话），
        // 侧栏也不再停 "New Chat"。
        sessionCatalog.getState().setDerivedTitle(entry.id, title)
        await invoke('pi_session_rename_at_path', { path, name: title })
        existingTitles.push(title)
        renamed += 1
      } catch (e) {
        // 失败可见、不占名额：下次启动还会重试这一条（标题已进显示层）。
        console.error('[session-title] 历史会话标题回填失败（该会话保持默认名）', path, e)
      }
    }
  } finally {
    running = false
  }
  return { renamed }
}
