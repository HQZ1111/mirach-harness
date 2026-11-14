/**
 * hermes 桌面端 `components/ui/confirm-dialog.tsx` 的移植。
 *
 * 共用确认对话框：打开即聚焦「确认」、Enter 确认（对话框任意位置）、
 * Esc/取消/背景关闭。自带 pending → done → close 的节拍与内联错误——调用方
 * 只传一个异步 onConfirm。
 *
 * 宿主裁剪（都是宿主事实，各有就地注释）：
 * - `useI18n()` → 文案字面量（宿主无 i18n 运行时）。
 * - `ActionStatus`（按钮内三态文案）→ 内联三元（宿主没有该组件）。
 * - `@/lib/icons` 的 AlertTriangle → lucide 同名。
 * 其余结构、键盘语义、600ms「完成」节拍、卸载清理逐字保留。
 */

import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface ConfirmSecondaryAction {
  label: string
  onClick: () => void
}

interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  /** Does the work. Throw to surface an inline error and keep the dialog open. */
  onConfirm: () => Promise<void> | void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  confirmLabel?: string
  busyLabel?: string
  doneLabel?: string
  cancelLabel?: string
  destructive?: boolean
  /** Close as soon as onConfirm resolves — for optimistic actions. */
  dismissOnConfirm?: boolean
  /** A third, non-destructive way out, shown between Cancel and Confirm. */
  secondaryAction?: ConfirmSecondaryAction
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  children,
  confirmLabel = '确认',
  busyLabel = '处理中…',
  doneLabel = '完成',
  cancelLabel = '取消',
  destructive = false,
  dismissOnConfirm = false,
  secondaryAction,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null)
  const closeTimerRef = useRef<null | number>(null)
  const [status, setStatus] = useState<'done' | 'idle' | 'saving'>('idle')
  const [error, setError] = useState<null | string>(null)
  const busy = status === 'saving' || status === 'done'

  useEffect(() => {
    if (open) {
      setStatus('idle')
      setError(null)
    }
  }, [open])

  // 卸载时清掉「完成」节拍的定时器——窗口期内卸载会让它对着已消失的树
  // 调 onClose（上游同款注释：vitest 下环境先拆掉会 ReferenceError）。
  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
    }
  }, [])

  async function run() {
    if (busy) {
      return
    }

    setError(null)

    if (dismissOnConfirm) {
      try {
        await onConfirm()
        onClose()
      } catch (err) {
        setError(err instanceof Error ? err.message : '操作失败')
      }

      return
    }

    setStatus('saving')

    try {
      await onConfirm()
      setStatus('done')
      closeTimerRef.current = window.setTimeout(() => {
        closeTimerRef.current = null
        onClose()
      }, 600)
    } catch (err) {
      setStatus('idle')
      setError(err instanceof Error ? err.message : '操作失败')
    }
  }

  return (
    <Dialog onOpenChange={(value) => !value && !busy && onClose()} open={open}>
      <DialogContent
        className='max-w-md'
        onKeyDown={(event) => {
          // Enter/Space 确认，不管焦点在哪个按钮（preventDefault 防焦点上的
          // 取消钮把它吞掉）。
          if ((event.key === 'Enter' || event.key === ' ') && !busy) {
            event.preventDefault()
            void run()
          }
        }}
        onOpenAutoFocus={(event) => {
          // 焦点必须落在对话框内，否则上面的键盘处理收不到——焦点留在打开
          // 它的元素（菜单项、侧栏行）上，Enter 会重新触发那个。
          event.preventDefault()
          confirmRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription className='whitespace-pre-line'>{description}</DialogDescription>
          ) : null}
        </DialogHeader>

        {children}
        {error && (
          <div className='flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive'>
            <AlertTriangle className='mt-0.5 size-3.5 shrink-0' />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter>
          <Button disabled={busy} onClick={onClose} type='button' variant='ghost'>
            {cancelLabel}
          </Button>
          {secondaryAction && (
            <Button
              disabled={busy}
              onClick={() => {
                secondaryAction.onClick()
                onClose()
              }}
              type='button'
              variant='secondary'
            >
              {secondaryAction.label}
            </Button>
          )}
          <Button
            disabled={busy}
            onClick={() => void run()}
            ref={confirmRef}
            variant={destructive ? 'destructive' : 'default'}
          >
            {status === 'saving' ? busyLabel : status === 'done' ? doneLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
