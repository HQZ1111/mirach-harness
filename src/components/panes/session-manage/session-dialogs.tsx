/**
 * 会话行弹层（hermes chat/sidebar/session-actions-menu.tsx 的
 * RenameSessionDialog + DeleteSessionDialog(ConfirmDialog 皮) 逐语义照抄；
 * ui 基元用本工程的 @/components/ui/dialog——hermes ConfirmDialog 的
 * 打开即聚焦确认钮 / Enter-Space 确认 / 失败内联红条 / 成功 done 600ms
 * 自关 全部保留）。
 *
 * 禁止兜底：重命名/删除的失败经 onSubmit 的 Promise reject 传播到这里，
 * 对话框**保持打开**并显示内联错误（文案 = hermes row.renameFailed /
 * 删除失败原样），调用方（行）的 console.error 负责控制台可见。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

import { isSubmitEnter } from './ime'

export interface ConfirmDialogProps {
  open: boolean
  onClose: () => void
  /** 干实事——throw 即失败：对话框保持打开并显示内联错误。 */
  onConfirm: () => Promise<void> | void
  title: string
  description?: string
  confirmLabel?: string
  busyLabel?: string
  doneLabel?: string
  cancelLabel?: string
  destructive?: boolean
}

/**
 * 共享确认对话框（hermes components/ui/confirm-dialog.tsx 照抄）：
 * 打开即聚焦 Confirm、Enter/Space 确认（焦点在谁身上都一样——preventDefault
 * 防聚焦的取消钮吞键）、Esc/取消/背景关闭；自己拥有 pending → done → 关
 * 的节奏与内联错误，调用方只递一个 async 的 onConfirm。
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = '确认',
  busyLabel = '处理中…',
  doneLabel = '完成',
  cancelLabel = '取消',
  destructive = false,
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

  // 卸载时清掉待触发的关闭计时器（done 拍 600ms 内卸载会打到已死的树）。
  useEffect(
    () => () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current)
        closeTimerRef.current = null
      }
    },
    [],
  )

  const run = useCallback(async () => {
    if (busy) return
    setError(null)
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
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [busy, onConfirm, onClose])

  return (
    <Dialog onOpenChange={(value) => !value && !busy && onClose()} open={open}>
      <DialogContent
        className="max-w-md"
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && !busy) {
            event.preventDefault()
            void run()
          }
        }}
        onOpenAutoFocus={(event) => {
          // 焦点必须落在对话框里（否则 Enter 键打到打开它的行/菜单项上，
          // 又触发一遍那行的动作）；Radix 默认会抢 X 钮——确认钮才是
          // Enter 的语义目标。
          event.preventDefault()
          confirmRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {error ? (
          <div className="text-destructive border-destructive/30 bg-destructive/10 flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
            {error}
          </div>
        ) : null}
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} type="button" variant="ghost">
            {cancelLabel}
          </Button>
          <Button
            disabled={busy}
            onClick={() => void run()}
            ref={confirmRef}
            type="button"
            variant={destructive ? 'destructive' : 'default'}
          >
            {status === 'saving' ? busyLabel : status === 'done' ? doneLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface RenameSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentTitle: string
  /** 干实事——throw/reject 即失败：对话框保持打开显示错误。 */
  onRename: (title: string) => Promise<void> | void
}

/**
 * 重命名对话框（hermes RenameSessionDialog 照抄）：打开即全选旧文本
 * （setTimeout select，避开 Radix 焦点归位抢跑）、Enter 提交（IME 合成期
 * Enter 不上报提交）、Esc 关、取消/保存。
 */
export function RenameSessionDialog({ open, onOpenChange, currentTitle, onRename }: RenameSessionDialogProps) {
  const [value, setValue] = useState(currentTitle)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (open) {
      setValue(currentTitle)
      setError(null)
      window.setTimeout(() => inputRef.current?.select(), 0)
    }
  }, [currentTitle, open])

  const submit = async () => {
    if (submitting) return
    const next = value.trim()
    if (next === currentTitle.trim()) {
      onOpenChange(false)
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await onRename(next)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>重命名会话</DialogTitle>
        </DialogHeader>
        <Input
          autoFocus
          disabled={submitting}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (isSubmitEnter(event)) {
              event.preventDefault()
              void submit()
            } else if (event.key === 'Escape') {
              onOpenChange(false)
            }
          }}
          placeholder="无标题会话"
          ref={inputRef}
          value={value}
        />
        {error ? (
          <div className="text-destructive border-destructive/30 bg-destructive/10 rounded-md border px-3 py-2 text-xs">
            {error}
          </div>
        ) : null}
        <DialogFooter>
          <Button disabled={submitting} onClick={() => onOpenChange(false)} type="button" variant="ghost">
            取消
          </Button>
          <Button disabled={submitting} onClick={() => void submit()} type="button">
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export interface DeleteSessionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionTitle: string
  /** 干实事——throw/reject 即失败：保持打开显示错误（内联红条）。 */
  onDelete: () => Promise<void>
}

/**
 * 删除确认（hermes DeleteSessionDialog = ConfirmDialog 皮，#61470 语义：
 * 删除不可逆，所有入口都收口到显式确认——桌面版曾直接点击即删）。
 */
export function DeleteSessionDialog({ open, onOpenChange, sessionTitle, onDelete }: DeleteSessionDialogProps) {
  return (
    <ConfirmDialog
      busyLabel="正在删除…"
      confirmLabel="删除"
      destructive
      doneLabel="会话已删除"
      description={`这将永久删除“${sessionTitle}”，且无法撤销。`}
      onConfirm={onDelete}
      onClose={() => onOpenChange(false)}
      open={open}
      title="删除会话？"
    />
  )
}
