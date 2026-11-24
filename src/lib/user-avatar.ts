/**
 * 用户头像（对话区「你」的消息头像）——2026-11-23 用户："现在的对话显示能加入
 * 头像系统吗，用户一个头像，ai也有头像……人物的头像可以在设置页的形象中设置，
 * 把桌面的文件夹3的用户头像也内置了"。
 *
 * 资源 = `public/avatars/user/u01..u41.jpg`（桌面「新建文件夹 (3)/用户头像」
 * 41 张图，构建期内置；最长边缩到 256px，见提交说明）。选择存 localStorage，
 * 设置页「形象」节读写；未知/损坏值回落到第一张（显式 console.error）。
 */
import { createStore, useStore } from 'zustand'

export const USER_AVATAR_COUNT = 41

export const USER_AVATARS: readonly string[] = Array.from(
  { length: USER_AVATAR_COUNT },
  (_, i) => `/avatars/user/u${String(i + 1).padStart(2, '0')}.jpg`,
)

export const DEFAULT_USER_AVATAR = USER_AVATARS[0]!

const STORAGE_KEY = 'mirach:user-avatar'

const readAvatar = (): string => {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (value && USER_AVATARS.includes(value)) return value
    if (value) console.error(`[avatar] 未知用户头像 ${value}——回落默认`)
  } catch (e) {
    console.error('[avatar] 读取用户头像失败——回落默认', e)
  }
  return DEFAULT_USER_AVATAR
}

interface UserAvatarState {
  avatar: string
  setAvatar: (avatar: string) => void
}

export const userAvatarStore = createStore<UserAvatarState>((set) => ({
  avatar: readAvatar(),
  setAvatar: (avatar) => {
    if (!USER_AVATARS.includes(avatar)) {
      console.error(`[avatar] 未知用户头像 ${avatar}——不保存`)
      return
    }
    try {
      localStorage.setItem(STORAGE_KEY, avatar)
    } catch (e) {
      console.error('[avatar] 保存用户头像失败', e)
    }
    set({ avatar })
  },
}))

export const useUserAvatar = (): string => useStore(userAvatarStore, (s) => s.avatar)
