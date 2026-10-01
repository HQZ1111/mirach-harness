/**
 * 接线版 composer：官方 elements/composer kit + @assistant-ui/react 原语。
 * 构图对齐官方（/elements/composer）：附件区在输入上方（无附件不占位）、
 * 工具行=左附件钮 / 右动作组（模型触发器 → 语音钮 → 上下文环 → 发送/
 * 停止）、容器=kit 默认 paper rounded-[24px] p-2.5。语音=Web Speech，
 * 交互对齐官方 Dictation（/elements/composer-voice）：激活期输入行被
 * ComposerVoice（波形+计时/Transcribing 微光）替换（官方："replace
 * ComposerInput while active, not sit beside it"），按钮 ink/ghost 两态。
 * 附件 UI=官方 attachment.aui 元素（图片缩略 tile + composer 专属移除钮
 * + 上传态遮罩）。斜杠/@=kit 匹配器；模型选择=pi 控制面（§4.5 IPC：
 * pi_list_models/pi_get_state/pi_set_model）。
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  ComposerPrimitive,
  useAuiState,
  unstable_useComposerInput,
} from '@assistant-ui/react'
import { useStore } from 'zustand'
import { FileText, ImageIcon, Languages } from 'lucide-react'

import {
  Composer,
  ComposerActions,
  ComposerAttachButton,
  ComposerBar,
  ComposerCommandItem,
  ComposerMenu,
  ComposerPersonItem,
  ComposerSend,
  ComposerToolbar,
  ComposerVoice,
  ComposerVoiceButton,
  useMentionMatches,
  useSlashMatches,
} from '@/components/assistant-ui/elements/composer'
import { ComposerAttachments as ComposerAttachmentsRow } from '@/components/assistant-ui/elements/attachment.aui'
import { branchBridge } from '@/components/assistant-ui/branch-store'
import { ContextDisplay } from '@/components/assistant-ui/context-display.aui'
import { ModelSelector, type ModelOption } from '@/components/assistant-ui/model-selector.aui'
import { useUsageBridge } from '@/components/assistant-ui/usage-bridge'

/** pi 模型目录条目（pi_list_models 返回形状）。 */
interface PiModelEntry {
  provider: string
  id: string
  name: string
  reasoning: boolean
  contextWindow: number
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

/**
 * 官方 Dictation 三态（/elements/composer-voice）：active=从点下麦克风
 * 到最终文本落定（拾音+沉降两段）；recording=仅拾音期（波形+计时）；
 * transcribing=停止后的收尾（波形沉降为 "Transcribing" 微光）。识别
 * 最终文本在拾音期即时进 composer（官方 runtime 语义："straight into
 * s.composer.text as it arrives"）。
 */
function useDictation(onFinal: (text: string) => void) {
  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const recRef = useRef<{ stop: () => void } | null>(null)
  // 识别实例启动后不会重绑回调——必须经 ref 读最新 onFinal。否则闭包
  // 捕获启动那一刻的 value：第一段识别写入后 value 变了，第二段识别
  // 仍按旧 value 追加 = 覆盖第一段（审查 #2 实锤）。
  const onFinalRef = useRef(onFinal)
  onFinalRef.current = onFinal
  // 计时器（官方模板同款）：recording 期间每秒走字，重新开始归零。
  useEffect(() => {
    if (!recording) return
    setSeconds(0)
    const timer = window.setInterval(() => setSeconds((s) => s + 1), 1000)
    return () => window.clearInterval(timer)
  }, [recording])
  // 身份校验收尾：onend 触发时用户可能已重新 start（recRef 指向新
  // 实例）——旧实例的收尾只清自己的状态，不得停掉新识别（审查 #3 实锤）。
  const settle = useCallback(() => {
    recRef.current = null
    setRecording(false)
    setTranscribing(false)
  }, [])
  const stop = useCallback(() => {
    const rec = recRef.current
    if (!rec) return
    // 先摘句柄再 stop：onend 身份校验失配 → 不重复清态；recording
    // 立即落假 → ComposerVoice 沉降为 Transcribing 微光（官方两段态）。
    recRef.current = null
    rec.stop()
    setRecording(false)
    setTranscribing(true)
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
    rec.onend = () => {
      if (recRef.current === rec) settle()
    }
    rec.start()
    recRef.current = rec
    setTranscribing(false)
    setRecording(true)
  }, [settle])
  const supported =
    typeof window !== 'undefined' &&
    !!((window as unknown as Record<string, unknown>).SpeechRecognition ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition)
  return { active: recording || transcribing, recording, transcribing, seconds, supported, start, stop }
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

  // ── fork 预填（branch store 通道）───────────────────────────────────
  // fork 成功后 runtime 把 selectedText 写进 branchBridge.composerPrefill；
  // 这里经 value 控制通道（unstable_useComposerInput.setText）写入 composer
  // ——用户重新提交即开新分支（上游语义）。seq 防重复应用：store 值常驻，
  // effect 随重渲重跑时不得把用户已编辑的内容盖回预填文本。
  const prefill = useStore(branchBridge, (s) => s.composerPrefill)
  const appliedPrefillSeqRef = useRef(0)
  useEffect(() => {
    if (!prefill || prefill.seq <= appliedPrefillSeqRef.current) return
    appliedPrefillSeqRef.current = prefill.seq
    setText(prefill.text)
  }, [prefill, setText])

  // pi 控制面：模型目录 + 当前选中。挂载时拉目录；state 随 isRunning
  // 变化重拉（会话按需创建后 trigger 自动从 "Select model" 点亮为真名）。
  // 错误即错误：目录/状态拉取失败 console 可见，不假装成功（目录空 =
  // 错误态）；首条消息前 pi_get_state 报 no active session 是预期域状态
  // （会话按需创建），不是被吞的错误。
  const [models, setModels] = useState<ModelOption[]>([])
  // 原始目录（取当前模型的 contextWindow 给用量环）
  const modelEntriesRef = useRef<PiModelEntry[]>([])
  const [currentModel, setCurrentModel] = useState<string | null>(null)
  // 思考档位（pi ThinkingLevel：off/minimal/low/medium/high/xhigh/max；
  // 不在 DEFAULT_EFFORT_OPTIONS 内的值 resolveEffort 落空 = 不选中）
  const [currentEffort, setCurrentEffort] = useState<string | null>(null)
  const { usage } = useUsageBridge()
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await invoke<{ models: PiModelEntry[] }>('pi_list_models')
        if (!cancelled) {
          modelEntriesRef.current = res.models ?? []
          setModels(toModelOptions(res.models ?? []))
        }
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
    void invoke<{ provider: string; modelId: string; thinkingLevel: string | null }>('pi_get_state')
      .then((st) => {
        if (!cancelled) {
          setCurrentModel(`${st.provider}/${st.modelId}`)
          // 思考档位随 state 回读（pi_get_state.thinkingLevel）
          setCurrentEffort(st.thinkingLevel ?? null)
        }
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
  const onEffortChange = useCallback((level: string) => {
    // 思考档位（§4.5 控制面，pi_set_thinking_level 参数 level）：成功才写
    // 本地态（经 pi_get_state 回读确认），失败保持原档位且错误可见——
    // 不乐观更新。
    void invoke('pi_set_thinking_level', { level })
      .then(() => invoke<{ thinkingLevel: string | null }>('pi_get_state'))
      .then((st) => setCurrentEffort(st.thinkingLevel ?? null))
      .catch((e) => console.error(`[pi] set_thinking_level ${level} 失败（保持原选择）`, e))
  }, [])
  // 当前模型的上下文窗口（用量环分母）——目录缺失或 <=0 时不渲染
  // ContextDisplay.Bar：旧写法 ?? 0 会除零 → Infinity → clamp 100 =
  // 红环误报（审查 #7）。
  const currentContextWindow = currentModel
    ? modelEntriesRef.current.find((e) => `${e.provider}/${e.id}` === currentModel)?.contextWindow
    : undefined

  // ── 斜杠/@ 菜单键盘导航（↑↓ 移动高亮、Enter/Tab 确认、Esc 关闭）──
  // Input 的传入 onKeyDown 先于内部 handleKeyPress 执行（包内
  // composeEventHandlers(onKeyDown, handleKeyPress)），preventDefault
  // 即可拦截内部 Enter 发送 / Esc 取消运行的默认行为。
  const [slashIdx, setSlashIdx] = useState(0)
  const [mentionIdx, setMentionIdx] = useState(0)
  // Esc 关闭记住当时 value——只有输入变化（匹配 token 改变）才重开。
  // 必须 setState：open 是 render 期派生态，纯 ref 写入不触发重渲——
  // Esc 后菜单视觉上不关（审查 #8 实锤）。
  const [dismissed, setDismissed] = useState<string | null>(null)
  const slashOpen = dismissed !== value && slash.length > 0
  const mentionOpen = dismissed !== value && mentions.length > 0

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
        setDismissed(value)
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
        setDismissed(value)
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
          {/* 官方容器默认：paper 面 + rounded-[24px] + p-2.5 + gap-2 */}
          <ComposerBar>
            {/* 官方构图第一条：附件区在输入上方；empty:hidden，无附件不占位 */}
            <ComposerAttachmentsRow />
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
            {/* 官方 Dictation：激活期输入行被 ComposerVoice 替换（波形+
                计时；停止后沉降 Transcribing 微光），Input 卸载即禁用 */}
            {dictation.active ? (
              <ComposerVoice
                className="flex-1"
                recording={dictation.recording}
                seconds={dictation.seconds}
              />
            ) : (
              <ComposerPrimitive.Input
                aria-label="消息输入"
                className="max-h-40 min-h-11 w-full resize-none bg-transparent px-3 text-[0.9375rem] leading-6 text-(--text) outline-none placeholder:text-(--text-4)"
                enterKeyHint="send"
                onKeyDown={onInputKeyDown}
                placeholder="输入消息，/ 指令，@ 成员…"
                rows={1}
              />
            )}
            {/* 官方工具行：左附件钮 / 右动作组（模型触发器 → 语音钮 →
                上下文环 → 发送/停止），顺序照 /elements/composer */}
            <ComposerToolbar>
              <ComposerPrimitive.AddAttachment asChild>
                <ComposerAttachButton aria-label="添加附件" />
              </ComposerPrimitive.AddAttachment>
              <ComposerActions>
                <ModelSelector
                  align="end"
                  className="rounded-full"
                  effort={currentEffort ?? ''}
                  models={models}
                  value={currentModel ?? undefined}
                  onEffortChange={onEffortChange}
                  onValueChange={onModelChange}
                  size="sm"
                  variant="ghost"
                />
                {dictation.supported && (
                  <ComposerVoiceButton
                    active={dictation.recording}
                    aria-label={dictation.recording ? '停止语音' : '语音输入'}
                    disabled={dictation.transcribing}
                    onClick={() => (dictation.recording ? dictation.stop() : dictation.start())}
                  />
                )}
                {/* 用量环（官方 compact 形态：环+百分比嵌动作组，悬停出
                    明细浮层）：usage 与模型上下文窗口任一缺失即不渲染；
                    窗口 <=0 同样不渲染（除零 → clamp 100 红环误报，审查
                    #7） */}
                {usage &&
                  currentModel &&
                  currentContextWindow !== undefined &&
                  currentContextWindow > 0 && (
                  <ContextDisplay.Ring
                    modelContextWindow={currentContextWindow}
                    usage={{
                      inputTokens: usage.inputTokens,
                      outputTokens: usage.outputTokens,
                      cachedInputTokens: usage.cachedInputTokens,
                      totalTokens: usage.totalTokens,
                    }}
                  />
                )}
                {isRunning ? (
                  <ComposerPrimitive.Cancel asChild>
                    <ComposerSend aria-label="停止生成" idle={false} streaming />
                  </ComposerPrimitive.Cancel>
                ) : (
                  <ComposerPrimitive.Send asChild>
                    <ComposerSend aria-label="发送" idle={!value.trim()} streaming={false} />
                  </ComposerPrimitive.Send>
                )}
              </ComposerActions>
            </ComposerToolbar>
          </ComposerBar>
        </ComposerPrimitive.AttachmentDropzone>
      </Composer>
    </ComposerPrimitive.Root>
  )
}
