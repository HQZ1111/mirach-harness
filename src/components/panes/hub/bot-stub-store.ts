/**
 * 机器人页的**做假面存储**（2026-11-07 用户定稿："可以做假ui，但是标红显示"）：
 * hermes Bot Mode 的群聊 / 活动 toasts / 筛选在宿主没有数据面——UI 照抄，
 * 数据本地存（群聊 log 仅本地记录、机器人互发不发生），消费处统一标红。
 *
 * 与真实面的分界：机器人预设（bots.v2）/ 分区（bot-sections.v1）是**真数据**
 * （launch 走 pi_create_bot_session）；本文件的群聊 log / toasts 开关 /
 * 群聊置顶是**假数据**（仅本栏消费）。标红纪律：凡读本文件数据的 UI 元素
 * 必须带 `data-stub="true"` 或 StubNote（红字"未接通"），见 bots-pane。
 */
import { createStore, useStore } from 'zustand'

/** 群聊房间（hermes GroupChat 的宿主对偶：仅本地 log，无机器人互发）。 */
export interface BotGroupChat {
  name: string
  /** 成员 = bot 名（bots.v2 的 name 键）。 */
  members: string[]
  log: { from: string; text: string; ts: number }[]
  /** 群头像（hermes GroupChatRoom.image 同名——创建时上传，data URL）。 */
  image?: null | string
  pinned?: boolean
  createdAt: number
}

interface BotStubState {
  groupChats: BotGroupChat[]
  activityToasts: boolean
  load: () => void
  saveGroups: (groups: BotGroupChat[]) => void
  createGroup: (name: string, members: string[], image?: null | string) => BotGroupChat | null
  renameGroup: (previous: string, name: string) => void
  removeGroup: (name: string) => void
  appendGroupMessage: (name: string, from: string, text: string) => void
  toggleGroupPinned: (name: string) => void
  setActivityToasts: (on: boolean) => void
}

const GROUPS_KEY = 'mirach.harness.bot-groups.v1'
const TOASTS_KEY = 'mirach.harness.bot-activity-toasts.v1'

export const useBotStubStore = <T,>(selector: (s: BotStubState) => T): T =>
  useStore(botStubStore, selector)

const parseGroups = (raw: string | null): BotGroupChat[] => {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (g): g is BotGroupChat =>
        typeof g === 'object' && g !== null && typeof (g as BotGroupChat).name === 'string',
    )
  } catch {
    return []
  }
}

export const botStubStore = createStore<BotStubState>((set, get) => ({
  groupChats: [],
  activityToasts: false,
  load: () => {
    set({
      groupChats: parseGroups(localStorage.getItem(GROUPS_KEY)),
      activityToasts: localStorage.getItem(TOASTS_KEY) === 'on',
    })
  },
  saveGroups: (groupChats) => {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(groupChats))
    set({ groupChats })
  },
  createGroup: (name, members, image) => {
    const trimmed = name.trim()
    if (!trimmed || members.length < 2) return null
    const group: BotGroupChat = {
      name: trimmed,
      members,
      log: [],
      image: image ?? null,
      createdAt: Date.now(),
    }
    get().saveGroups([...get().groupChats, group])
    return group
  },
  renameGroup: (previous, name) => {
    get().saveGroups(get().groupChats.map((g) => (g.name === previous ? { ...g, name } : g)))
  },
  removeGroup: (name) => {
    get().saveGroups(get().groupChats.filter((g) => g.name !== name))
  },
  appendGroupMessage: (name, from, text) => {
    get().saveGroups(
      get().groupChats.map((g) =>
        g.name === name ? { ...g, log: [...g.log, { from, text, ts: Date.now() }] } : g,
      ),
    )
  },
  toggleGroupPinned: (name) => {
    get().saveGroups(
      get().groupChats.map((g) => (g.name === name ? { ...g, pinned: !g.pinned } : g)),
    )
  },
  setActivityToasts: (on) => {
    localStorage.setItem(TOASTS_KEY, on ? 'on' : 'off')
    set({ activityToasts: on })
  },
}))
