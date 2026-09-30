/**
 * 接线版 composer：官方 elements/composer kit + @assistant-ui/react 原语。
 * 语音=Web Speech；斜杠/@=kit 匹配器；附件=运行时适配器（图片/文本）；
 * 模型选择=pi 控制面（§4.5 IPC：pi_list_models/pi_get_state/pi_set_model）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  ComposerPrimitive,
  useAuiState,
  unstable_useComposerInput,
} from '@assistant-ui/react'
import { ArrowUpIcon, FileText, ImageIcon, Languages, SquareIcon } from 'lucide-react'

import {
  Composer,
  ComposerAttachButton,
  ComposerBar,
  ComposerCommandItem,
  ComposerMenu,
  ComposerPersonItem,
  ComposerToolbar,
  useMentionMatches,
  useSlashMatches,
} from '@/components/assistant-ui/elements/composer'
import { ModelSelector, type ModelOption } from '@/components/assistant-ui/model-selector.aui'
import { cn } from '@/lib/utils'

/** pi 模型目录条目（pi_list_models 返回形状）。 */
interface PiModelEntry {
  provider: string
  id: string
  name: string
  reasoning: boolean
}

/** pi 模型目录 → ModelSelector 选项；reasoning 模型带默认三档。 */
function toModelOptions(entries: PiModelEntry[]): ModelOption[] {
  return entries.map((e) => ({
    id: `${e.provider}/${e.id}`,
    name: e.name || e.id,
    description: e.provider,
    ...(e.reasoning ? { efforts: true as const } : {}),
  }))
}

const COMMANDS = [
  { name: 'image', description: '生成一张图片', icon: ImageIcon },
  { name: 'summary', description: '总结当前对话', icon: FileText },
  { name: 'translate', description: '翻译成英文', icon: Languages },
] as const

const PEOPLE = [
  { name: 'mirach', role: 'agent' },
  { name: 'reviewer', role: 'human' },
] as const

function MicGlyph() {
  return (
    <svg className="size-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path d="M12 19v3" />
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    </svg>
  )
}

function useDictation(onFinal: (text: string) => void) {
  const [recording, setRecording] = useState(false)
  const recRef = useRef<{ stop: () => void } | null>(null)
  const stop = useCallback(() => {
    recRef.current?.stop()
    recRef.current = null
    setRecording(false)
  }, [])
  const start = useCallback(() => {
    const w = window as unknown as Record<string, unknown>
    const SR = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
      | (new () => {
          lang: string
          continuous: boolean
          interimResults: boolean
          onresult: ((e: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null
          onend: (() => void) | null
          start: () => void
          stop: () => void
        })
      | undefined
    if (!SR) return
    const rec = new SR()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = false
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) onFinal(e.results[i][0].transcript)
      }
    }
    rec.onend = () => stop()
    rec.start()
    recRef.current = rec
    setRecording(true)
  }, [onFinal, stop])
  const supported =
    typeof window !== 'undefined' &&
    !!((window as unknown as Record<string, unknown>).SpeechRecognition ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition)
  return { recording, supported, start, stop }
}

function AttachmentsChips() {
  const attachments = useAuiState((s) => s.composer.attachments)
  if (!attachments || attachments.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 px-1 pt-1">
      {attachments.map((a) => (
        <span
          className="flex items-center gap-2 rounded-xl border border-(--stroke-soft) px-2 py-1 text-xs text-(--text-2)"
          key={a.id}
        >
          {a.name}
        </span>
      ))}
    </div>
  )
}

export function ComposerWired() {
  const input = unstable_useComposerInput()
  const value = input.value
  const isRunning = useAuiState((s) => s.thread.isRunning)
  const setText = input.setText
  const slash = useSlashMatches(value, COMMANDS)
  const mentions = useMentionMatches(value, PEOPLE)
  const dictation = useDictation((text) => {
    const cur = value
    setText(cur ? cur + ' ' + text : text)
  })

  // pi 控制面：模型目录 + 当前选中。挂载时拉目录；state 随 isRunning
  // 变化重拉（会话按需创建后 trigger 自动从 "Select model" 点亮为真名）。
  const [models, setModels] = useState<ModelOption[]>([])
  const [currentModel, setCurrentModel] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await invoke<{ models: PiModelEntry[] }>('pi_list_models')
        if (!cancelled) setModels(toModelOptions(res.models ?? []))
      } catch {
        // 无会话/桥未起：留空态
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    void invoke<{ provider: string; modelId: string }>('pi_get_state')
      .then((st) => {
        if (!cancelled) setCurrentModel(`${st.provider}/${st.modelId}`)
      })
      .catch(() => {
        // 无会话：保留占位
      })
    return () => {
      cancelled = true
    }
  }, [isRunning])
  const onModelChange = useCallback((id: string) => {
    const [provider, modelId] = id.split('/')
    setCurrentModel(id)
    void invoke('pi_set_model', { provider, modelId }).catch((e) =>
      console.error('[pi] set_model 失败', e),
    )
  }, [])

  return (
    <ComposerPrimitive.Root asChild>
      {/* max-w-none：官方 Composer kit 自带 max-w-lg（512px）第二层收窄，
          与 thread 的 44rem 消息区叠层——输入框比消息区窄一截（实测 480 vs
          660）。twMerge 下 max-w-none 覆盖 kit 默认，宽度全权归外层。 */}
      <Composer className="w-full max-w-none">
        <ComposerPrimitive.AttachmentDropzone asChild>
          <ComposerBar className="rounded-(--composer-radius) border border-(--stroke-soft) bg-transparent p-2.5">
            <AttachmentsChips />
            {slash.length > 0 && (
              <ComposerMenu open>
                {slash.map((c) => (
                  <ComposerCommandItem key={c.name} command={c} active={false} onClick={() => setText('/' + c.name + ' ')} />
                ))}
              </ComposerMenu>
            )}
            {mentions.length > 0 && (
              <ComposerMenu open align="start">
                {mentions.map((p) => (
                  <ComposerPersonItem
                    key={p.name}
                    person={p}
                    active={false}
                    onClick={() => setText(value.replace(/@[\w]*$/, '@' + p.name + ' '))}
                  />
                ))}
              </ComposerMenu>
            )}
            <ComposerPrimitive.Input
              aria-label="消息输入"
              className="max-h-40 min-h-10 w-full resize-none bg-transparent px-2 text-[0.9375rem] leading-6 text-(--text) outline-none placeholder:text-(--text-4)"
              enterKeyHint="send"
              placeholder="输入消息，/ 指令，@ 成员…"
              rows={1}
            />
            <ComposerToolbar>
              <ComposerPrimitive.AddAttachment asChild>
                <ComposerAttachButton className="text-(--text-3) hover:text-(--text)" />
              </ComposerPrimitive.AddAttachment>
              <div className="ml-auto flex items-center gap-1.5">
                <ModelSelector
                  align="end"
                  models={models}
                  value={currentModel ?? undefined}
                  onValueChange={onModelChange}
                  size="sm"
                  variant="ghost"
                />
                {dictation.supported && (
                  <button
                    aria-label={dictation.recording ? '停止语音' : '语音输入'}
                    className={cn(
                      'grid size-8 place-items-center rounded-full',
                      dictation.recording ? 'bg-(--text) text-(--surface)' : 'text-(--text-3) hover:text-(--text)',
                    )}
                    onClick={() => (dictation.recording ? dictation.stop() : dictation.start())}
                    title={dictation.recording ? '停止语音' : '语音输入'}
                    type="button"
                  >
                    {dictation.recording ? <SquareIcon className="size-3.5 fill-current" /> : <MicGlyph />}
                  </button>
                )}
                {isRunning ? (
                  <ComposerPrimitive.Cancel asChild>
                    <button aria-label="停止生成" className="grid size-8 place-items-center rounded-full bg-(--text) text-(--surface)" type="button">
                      <SquareIcon className="size-3.5 fill-current" />
                    </button>
                  </ComposerPrimitive.Cancel>
                ) : (
                  <ComposerPrimitive.Send asChild>
                    <button
                      aria-label="发送"
                      className={cn(
                        'grid size-8 place-items-center rounded-full transition-colors',
                        value.trim() ? 'bg-(--fl-accent) text-white' : 'bg-(--stroke-soft) text-(--text-4)',
                      )}
                      type="button"
                    >
                      <ArrowUpIcon className="size-4" />
                    </button>
                  </ComposerPrimitive.Send>
                )}
              </div>
            </ComposerToolbar>
          </ComposerBar>
        </ComposerPrimitive.AttachmentDropzone>
      </Composer>
    </ComposerPrimitive.Root>
  )
}

export type { ReactNode }
