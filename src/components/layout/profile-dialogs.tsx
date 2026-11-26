/**
 * 配置档案管理对话框（hermes `app/profiles/{rename-profile-dialog,
 * delete-profile-dialog}` + `ProfileRail` 的 EditSoulDialog 宿主版，
 * 2026-11-26）。档案栏与「管理配置档案」页共用，避免两套表单。
 */
import { useEffect, useState } from 'react'

import { botDisplayName, type BotPreset } from '@/components/panes/hub/bots-store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

/** 重命名：具名档案 = profile 目录名；本体（default）= 显示名称（hermes
 *  displayNameTitle 同语义，canonical id 仍是 default）。 */
export function RenameProfileDialog({
  bot,
  onClose,
  onSubmit,
}: {
  bot: BotPreset | null
  onClose: () => void
  onSubmit: (bot: BotPreset, next: string) => Promise<void>
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    if (bot) {
      setName(bot.name === 'default' ? bot.title : bot.name)
      setError(null)
      setBusy(false)
    }
  }, [bot])

  const trimmed = name.trim()
  const isDefault = bot?.name === 'default'
  const invalidReason =
    !trimmed
      ? '名称不能为空'
      : !isDefault && trimmed === 'default'
        ? 'default 是本体环境，不能重命名'
        : !isDefault && (/[\\/]/.test(trimmed) || trimmed.includes('..'))
          ? '名称不能包含路径分隔符或 ..'
          : null

  const submit = async (): Promise<void> => {
    if (!bot || invalidReason) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(bot, trimmed)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog onOpenChange={(open) => !open && !busy && onClose()} open={bot !== null}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isDefault ? '为智能体命名' : '重命名配置档案'}</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-(--ui-text-tertiary)">
          {isDefault
            ? '设置整个应用中显示的默认智能体名称；内部配置档案 ID 仍是 default。'
            : '修改环境目录名（磁盘路径）；显示名称保持不变。正在使用的环境会先切到默认再改。'}
        </p>
        <Input
          autoFocus
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submit()
          }}
          value={name}
        />
        {invalidReason && <p className="text-xs text-(--ui-text-tertiary)">{invalidReason}</p>}
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} type="button" variant="ghost">
            取消
          </Button>
          <Button disabled={busy || invalidReason !== null} onClick={() => void submit()} type="button">
            {busy ? (isDefault ? '保存中…' : '重命名中…') : isDefault ? '保存' : '重命名'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 编辑 SOUL.md（bot.systemPrompt：宿主 SessionOptions.system_prompt 的
 *  SOUL 对偶；pi 在下一次建会话时消费）。 */
export function SoulDialog({
  bot,
  onClose,
  onSave,
}: {
  bot: BotPreset | null
  onClose: () => void
  onSave: (bot: BotPreset, content: string) => Promise<void>
}) {
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<null | string>(null)

  useEffect(() => {
    if (bot) {
      setContent(bot.systemPrompt ?? '')
      setError(null)
      setBusy(false)
    }
  }, [bot])

  const save = async (): Promise<void> => {
    if (!bot) return
    setBusy(true)
    setError(null)
    try {
      await onSave(bot, content)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog onOpenChange={(open) => !open && !busy && onClose()} open={bot !== null}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{bot ? `${botDisplayName(bot)} · SOUL.md` : 'SOUL.md'}</DialogTitle>
        </DialogHeader>
        <Textarea
          className="min-h-72 font-mono text-xs"
          disabled={busy}
          onChange={(event) => setContent(event.target.value)}
          placeholder="此环境的系统提示词 / 人格说明。留空则使用默认值。"
          value={content}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button disabled={busy} onClick={onClose} type="button" variant="ghost">
            取消
          </Button>
          <Button disabled={busy} onClick={() => void save()} type="button">
            {busy ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 结果提示（宿主没有全局 toast；导出/导入/保存的真实结果在这里可见）。 */
export function NoticeDialog({ message, onClose }: { message: null | string; onClose: () => void }) {
  return (
    <Dialog onOpenChange={(open) => !open && onClose()} open={message !== null}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>配置档案</DialogTitle>
        </DialogHeader>
        <p className="break-all text-sm">{message}</p>
        <DialogFooter>
          <Button onClick={onClose} type="button">
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
