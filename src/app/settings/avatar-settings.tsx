/**
 * 设置 → 形象（2026-11-23）：用户头像选择。
 *
 * 数据面 = `src/lib/user-avatar.ts`（localStorage `mirach:user-avatar`）；
 * 资源 = `public/avatars/user/u01..u41.jpg`（桌面「新建文件夹 (3)/用户头像」
 * 的 41 张内置图）。对话区用户消息旁的圆形头像读同一 store。
 *
 * 2026-11-24 用户："形象里的头像弹窗选择或者给个展开按钮"——41 张图不再
 * 常驻页面（会把整页撑得很长），改成「选择头像」按钮 + 弹窗网格。
 */
import { Check } from 'lucide-react'
import { useState } from 'react'
import { useStore } from 'zustand'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { DEFAULT_USER_AVATAR, USER_AVATARS, userAvatarStore } from '@/lib/user-avatar'
import { cn } from '@/lib/utils'

export function AvatarSettings() {
  const avatar = useStore(userAvatarStore, (s) => s.avatar)
  const setAvatar = userAvatarStore.getState().setAvatar
  const [pickerOpen, setPickerOpen] = useState(false)

  return (
    <div className="set-persona">
      <section className="set-persona-card">
        <div className="set-persona-card-head">
          <div className="set-persona-card-head-text">
            <h3 className="set-persona-card-title">用户头像</h3>
            <p className="set-persona-card-desc">
              显示在对话区「你」的消息旁边。内置头像来自本机「用户头像」图集；选择立即保存。
            </p>
          </div>
        </div>
        <div className="set-persona-card-body">
          <div className="flex items-center gap-4">
            <img
              alt="当前用户头像"
              className="border-(--stroke-soft) size-16 shrink-0 rounded-full border object-cover"
              src={avatar}
            />
            <div className="min-w-0">
              <p className="text-foreground text-sm font-medium">当前头像</p>
              <p className="text-(--text-3) mt-0.5 text-xs">
                从 41 个内置头像中选择。
              </p>
              <div className="mt-2 flex items-center gap-3">
                <button
                  className="set-btn"
                  onClick={() => setPickerOpen(true)}
                  type="button"
                >
                  选择头像…
                </button>
                {avatar !== DEFAULT_USER_AVATAR && (
                  <button
                    className="text-(--brand) text-xs hover:underline"
                    onClick={() => setAvatar(DEFAULT_USER_AVATAR)}
                    type="button"
                  >
                    恢复默认
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      <Dialog onOpenChange={setPickerOpen} open={pickerOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>选择头像</DialogTitle>
            <DialogDescription>
              内置的 {USER_AVATARS.length} 个头像，点击立即保存。
            </DialogDescription>
          </DialogHeader>
          <div
            aria-label="选择用户头像"
            className="grid max-h-[60vh] grid-cols-[repeat(auto-fill,minmax(72px,1fr))] gap-3 overflow-y-auto py-1"
            role="radiogroup"
          >
            {USER_AVATARS.map((src, index) => {
              const selected = src === avatar
              return (
                <button
                  aria-checked={selected}
                  aria-label={`头像 ${index + 1}`}
                  className={cn(
                    'relative aspect-square overflow-hidden rounded-full border-2 transition-colors',
                    selected
                      ? 'border-(--brand)'
                      : 'border-(--stroke-soft) hover:border-(--stroke)',
                  )}
                  data-selected={selected ? '1' : undefined}
                  key={src}
                  onClick={() => {
                    setAvatar(src)
                    setPickerOpen(false)
                  }}
                  role="radio"
                  type="button"
                >
                  <img alt="" className="size-full object-cover" loading="lazy" src={src} />
                  {selected && (
                    <span className="absolute inset-0 grid place-items-center bg-black/35 text-white">
                      <Check className="size-[var(--size-icon-lg)]" />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
