/**
 * 接线版 composer：官方 elements/composer kit + @assistant-ui/react 原语。
 * 语音=Web Speech；斜杠/@=kit 匹配器；附件=运行时适配器（图片/文本）；
 * 模型选择=pi 控制面（§4.5 IPC：pi_list_models/pi_get_state/pi_set_model）。
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  ComposerPrimitive,
  useAui,
  useAuiState,
  unstable_useComposerInput,
} from '@assistant-ui/react'
import { ArrowUpIcon, FileText, ImageIcon, Languages, SquareIcon, XIcon } from 'lucide-react'

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
  // 识别实例启动后不会重绑回调——必须经 ref 读最新 onFinal。否则闭包
  // 捕获启动那一刻的 value：第一段识别写入后 value 变了，第二段识别
  // 仍按旧 value 追加 = 覆盖第一段（审查 #2 实锤）。
  const onFinalRef = useRef(onFinal)
  onFinalRef.current = onFinal
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
        if (e.results[i].isFinal) onFinalRef.current(e.results[i][0].transcript)
      }
    }
    // 身份校验：onend 触发时用户可能已重新 start（recRef 指向新实例）——
    // 旧实例的收尾只清自己的状态，不得停掉新识别（审查 #3 实锤）。
    rec.onend = () => {
      if (recRef.current === rec) {
        recRef.current = null
        setRecording(false)
      }
    }
    rec.start()
    recRef.current = rec
    setRecording(true)
  }, [stop])
  const supported =
    typeof window !== 'undefined' &&
    !!((window as unknown as Record<string, unknown>).SpeechRecognition ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition)
  return { recording, supported, start, stop }
}

function AttachmentsChips() {
  const attachments = useAuiState((s) => s.composer.attachments)
  const aui = useAui()
  if (!attachments || attachments.length === 0) return null
  return (
    <div className="flex flex-wrap gap-2 px-1 pt-1">
      {attachments.map((a) => (
        <span
          className="flex items-center gap-1.5 rounded-xl border border-(--stroke-soft) px-2 py-1 text-xs text-(--text-2)"
          key={a.id}
        >
          {a.name}
          <button
            aria-label={`移除附件 ${a.name}`}
            className="text-(--text-4) hover:text-(--text)"
            onClick={() => void aui.composer.attachment({ id: a.id }).remove()}
            type="button"
          >
            <XIcon className="size-3" />
          </button>
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
  // 错误即错误：目录/状态拉取失败 console 可见，不假装成功（目录空 =
  // 错误态）；首条消息前 pi_get_state 报 no active session 是预期域状态
  // （会话按需创建），不是被吞的错误。
  const [models, setModels] = useState<ModelOption[]>([])
  const [currentModel, setCurrentModel] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await invoke<{ models: PiModelEntry[] }>('pi_list_models')
        if (!cancelled) setModels(toModelOptions(res.models ?? []))
      } catch (e) {
        console.error('[pi] 模型目录获取失败', e)
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
      .catch((e) => {
        // 首条消息前必然发生（无会话=预期域状态）；其余失败照常可见
        if (!String(e).includes('no active session')) console.error('[pi] 会话状态获取失败', e)
      })
    return () => {
      cancelled = true
    }
  }, [isRunning])
  const onModelChange = useCallback((id: string) => {
    // provider 不含 '/'，model id 可能含（HF 风格 meta-llama/Llama-3）——
    // 必须按第一个 '/' 切分；split('/') 会截断 modelId（审查 #1 实锤）。
    const idx = id.indexOf('/')
    if (idx <= 0) return
    const provider = id.slice(0, idx)
    const modelId = id.slice(idx + 1)
    // 错误即错误：set_model 成功才更新选中态，失败保持原值且错误可见
    // ——不乐观更新（UI 假装切换成功 = 兜底）。
    void invoke('pi_set_model', { provider, modelId })
      .then(() => setCurrentModel(id))
      .catch((e) => console.error(`[pi] set_model ${id} 失败（保持原选择）`, e))
  }, [])

  // ── 斜杠/@ 菜单键盘导航（↑↓ 移动高亮、Enter/Tab 确认、Esc 关闭）──
  // Input 的传入 onKeyDown 先于内部 handleKeyPress 执行（包内
  // composeEventHandlers(onKeyDown, handleKeyPress)），preventDefault
  // 即可拦截内部 Enter 发送 / Esc 取消运行的默认行为。
  const [slashIdx, setSlashIdx] = useState(0)
  const [mentionIdx, setMentionIdx] = useState(0)
  // Esc 关闭记住当时 value——只有输入变化（匹配 token 改变）才重开
  const dismissedRef = useRef<string | null>(null)
  const slashOpen = dismissedRef.current !== value && slash.length > 0
  const mentionOpen = dismissedRef.current !== value && mentions.length > 0

  useEffect(() => {
    setSlashIdx(0)
    setMentionIdx(0)
  }, [value])

  const onInputKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      const n = slash.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIdx((i) => (Math.min(i, n - 1) + 1) % n)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIdx((i) => (Math.min(i, n - 1) - 1 + n) % n)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const c = slash[Math.min(slashIdx, n - 1)]
        if (c) setText('/' + c.name + ' ')
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        dismissedRef.current = value
        return
      }
    }
    if (mentionOpen) {
      const n = mentions.length
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setMentionIdx((i) => (Math.min(i, n - 1) + 1) % n)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setMentionIdx((i) => (Math.min(i, n - 1) - 1 + n) % n)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const p = mentions[Math.min(mentionIdx, n - 1)]
        if (p) setText(value.replace(/@[\w]*$/, '@' + p.name + ' '))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        dismissedRef.current = value
      }
    }
  }

  return (
    <ComposerPrimitive.Root asChild>
      {/* max-w-none：官方 Composer kit 自带 max-w-lg（512px）第二层收窄，
          与 thread 的 44rem 消息区叠层——输入框比消息区窄一截（实测 480 vs
          660）。twMerge 下 max-w-none 覆盖 kit 默认，宽度全权归外层。 */}
      <Composer className="w-full max-w-none">
        <ComposerPrimitive.AttachmentDropzone asChild>
          <ComposerBar className="rounded-(--composer-radius) border border-(--stroke-soft) bg-transparent p-2.5">
            <AttachmentsChips />
            {slashOpen && (
              <ComposerMenu open>
                {slash.map((c, i) => (
                  <ComposerCommandItem
                    key={c.name}
                    command={c}
                    active={i === Math.min(slashIdx, slash.length - 1)}
                    onClick={() => setText('/' + c.name + ' ')}
                  />
                ))}
              </ComposerMenu>
            )}
            {mentionOpen && (
              <ComposerMenu open align="start">
                {mentions.map((p, i) => (
                  <ComposerPersonItem
                    key={p.name}
                    person={p}
                    active={i === Math.min(mentionIdx, mentions.length - 1)}
                    onClick={() => setText(value.replace(/@[\w]*$/, '@' + p.name + ' '))}
                  />
                ))}
              </ComposerMenu>
            )}
            <ComposerPrimitive.Input
              aria-label="消息输入"
              className="max-h-40 min-h-10 w-full resize-none bg-transparent px-2 text-[0.9375rem] leading-6 text-(--text) outline-none placeholder:text-(--text-4)"
              enterKeyHint="send"
              onKeyDown={onInputKeyDown}
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
