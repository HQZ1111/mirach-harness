/**
 * 接线版 composer：官方 elements/composer kit + @assistant-ui/react 原语。
 * 构图对齐官方（/elements/composer）：附件区在输入上方（无附件不占位）、
 * 工具行=左附件钮 / 右动作组（模型触发器 → 语音钮 → 上下文环 → 发送/
 * 停止）、容器=kit paper rounded-[20px]（用户 2026-10-05：24→20）p-2.5。语音=Web Speech，
 * 交互对齐官方 Dictation（/elements/composer-voice）：激活期输入行被
 * ComposerVoice（波形+计时/Transcribing 微光）替换（官方："replace
 * ComposerInput while active, not sit beside it"），按钮 ink/ghost 两态。
 * 附件 UI=官方 attachment.aui 元素（图片缩略 tile + composer 专属移除钮
 * + 上传态遮罩）。斜杠/@=kit 匹配器；模型选择=pi 控制面（§4.5 IPC：
 * pi_list_models/pi_get_state/pi_set_model）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FC, type KeyboardEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  ComposerPrimitive,
  useAui,
  useAuiState,
  unstable_useComposerInput,
  unstable_useComposerInputHistory,
} from '@assistant-ui/react'
import { useStore } from 'zustand'
import { CheckIcon, FileText, ImageIcon, Languages, LightbulbIcon, Loader2Icon, MicIcon, PhoneIcon, SquareIcon, Volume2Icon, VolumeXIcon } from 'lucide-react'

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
  useSlashMatches,
  type ComposerPerson,
} from '@/components/assistant-ui/elements/composer'
import { useContributions } from '@/hermes-shim/contrib/react/use-contributions'
import { COMPOSER_AT_COMPLETIONS_AREA } from '@/hermes-shim/contrib/composer-middleware'
import { getComposerDraft, setComposerDraft } from '@/components/assistant-ui/composer-draft-store'
import { ComposerAttachments as ComposerAttachmentsRow } from '@/components/assistant-ui/elements/attachment.aui'
import { branchBridge } from '@/components/assistant-ui/branch-store'
import { ContextDisplay } from '@/components/assistant-ui/context-display.aui'
import { PermissionModeChip } from '@/components/assistant-ui/permission-mode-chip'
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/motion/context-menu'
import { useAutoSpeakRepliesPref, voicePrefsStore } from '@/components/assistant-ui/voice-prefs'
import { useVoiceLive, voiceLiveStore } from '@/components/assistant-ui/voice-live-store'
import { ghostButton, inkButton } from '@/components/assistant-ui/elements/surfaces'
import { ComposerStatusBadge } from '@/components/assistant-ui/composer-status-badge'
import { ComposerTopSlot } from '@/components/assistant-ui/composer-top-slot'
import { useThreadSessionId } from '@/components/assistant-ui/thread-session-id'
import { ModelSelector, type ModelOption } from '@/components/assistant-ui/model-selector.aui'
import {
  modelCatalogStore,
  toModelOptions,
} from '@/components/assistant-ui/model-catalog-store'
import { useUsageBridge } from '@/components/assistant-ui/usage-bridge'
import { ComposerStatsLine } from '@/components/assistant-ui/composer-stats-line'
import { pickAttachmentFiles } from '@/components/assistant-ui/attachments'

const COMMANDS = [
  { name: 'image', description: '生成一张图片', icon: ImageIcon },
  { name: 'summary', description: '总结当前对话', icon: FileText },
  { name: 'translate', description: '翻译成英文', icon: Languages },
] as const

/** pi ThinkingLevel（引擎真实档位，pi_set_thinking_level 直接消费）。
 *  中文名 = 展示用，与引擎值一一对应；`null`（未设）按引擎默认（不选）展示。 */
const THINKING_LEVELS = [
  { level: 'off', label: '关闭', hint: '不输出思考' },
  { level: 'minimal', label: '最少', hint: '最少思考' },
  { level: 'low', label: '低', hint: '轻量思考' },
  { level: 'medium', label: '中', hint: '平衡（常用）' },
  { level: 'high', label: '高', hint: '深度思考' },
  { level: 'xhigh', label: '极高', hint: '大量思考' },
  { level: 'max', label: '最大', hint: '完整推理预算' },
] as const

/**
 * 思考强度按钮（工具栏常驻入口）。
 *
 * 与模型选择器内的档位**同一份数据面**（pi_set_thinking_level +
 * pi_get_state 回读），不另建状态；这里只是把能力提到可见处。
 */
const ThinkingEffortButton: FC<{
  effort: string | null
  onChange: (level: string) => void
}> = ({ effort, onChange }) => {
  const current = THINKING_LEVELS.find((l) => l.level === effort)
  const label = current?.label ?? '思考'
  return (
    <ContextMenu anchor="trigger">
      <ContextMenuTrigger>
        <button
          type="button"
          aria-label={`思考强度：${label}`}
          title={`思考强度：${label}`}
          data-slot="thinking-effort-button"
          className="text-(--text-3) hover:text-(--text-1) flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-2 text-[13px] transition-colors"
        >
          {/* 灯泡 = 思考强度（不依赖模型声明的推理图标） */}
          <LightbulbIcon className="size-[14px]" />
          <span>{label}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {THINKING_LEVELS.map((l) => (
          <ContextMenuItem key={l.level} onSelect={() => onChange(l.level)}>
            <span className="flex-1">{l.label}</span>
            <span className="text-(--text-4) text-[11px]">{l.hint}</span>
            {effort === l.level && <CheckIcon className="ml-1 size-[14px] shrink-0" />}
          </ContextMenuItem>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  )
}

const PEOPLE = [
  { name: 'mirach', role: 'agent' },
  { name: 'reviewer', role: 'human' },
] as const

/** 把末尾 @token 替换为选中的 handle。支持 `-` / `.` / `@connection` 的
 *  贡献行形式（宿主原 `applyMention` 的 `[\w]*` 不认连字符，会把
 *  `@my-bot` 的插入弄坏）。 */
function applyMentionRow(value: string, name: string): string {
  return value.replace(/@[\w@.-]*$/, `@${name} `)
}

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
  /** onend 不保证一定到达（WebView2 权限拒绝/设备拔出）；停止后留一个
   *  看门狗，不能让 transcribing 永久卡住（用户："点击之后没法取消"）。 */
  const settleTimerRef = useRef<number | null>(null)
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
  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current === null) return
    window.clearTimeout(settleTimerRef.current)
    settleTimerRef.current = null
  }, [])
  // 收尾：onend / onerror / 看门狗都走这里，清干净两段状态。
  const settle = useCallback(() => {
    clearSettleTimer()
    recRef.current = null
    setRecording(false)
    setTranscribing(false)
  }, [clearSettleTimer])
  const stop = useCallback(() => {
    const rec = recRef.current
    if (!rec) {
      setRecording(false)
      setTranscribing(false)
      return
    }
    // 不要在这里把 recRef 置空：onend 的身份校验还要靠它收尾
    // （旧实现先置空 → onend 永远失配 → transcribing 卡死）。
    setRecording(false)
    setTranscribing(true)
    clearSettleTimer()
    settleTimerRef.current = window.setTimeout(() => settle(), 3000)
    try {
      rec.stop()
    } catch (e) {
      console.error('[dictation] stop failed', e)
      settle()
    }
  }, [clearSettleTimer, settle])
  /** 用户再点一次麦克风 / 关闭面板：立刻中止，不等待 onend。 */
  const cancel = useCallback(() => {
    const rec = recRef.current
    recRef.current = null
    clearSettleTimer()
    if (rec) {
      try {
        rec.stop()
      } catch (e) {
        console.error('[dictation] cancel stop failed', e)
      }
    }
    setRecording(false)
    setTranscribing(false)
  }, [clearSettleTimer])
  const start = useCallback(() => {
    const w = window as unknown as Record<string, unknown>
    const SR = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as
      | (new () => {
          lang: string
          continuous: boolean
          interimResults: boolean
          onresult: ((e: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null
          onend: (() => void) | null
          onerror: ((e: unknown) => void) | null
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
    rec.onerror = (e) => {
      console.error('[dictation] recognition error', e)
      if (recRef.current === rec) settle()
    }
    recRef.current = rec
    clearSettleTimer()
    setTranscribing(false)
    try {
      rec.start()
    } catch (e) {
      console.error('[dictation] start failed', e)
      settle()
      return
    }
    setRecording(true)
  }, [clearSettleTimer, settle])
  const supported =
    typeof window !== 'undefined' &&
    !!((window as unknown as Record<string, unknown>).SpeechRecognition ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition)
  return { active: recording || transcribing, recording, transcribing, seconds, supported, start, stop, cancel }
}

/**
 * composer 语音菜单（hermes VoiceMenu 的宿主对偶，2026-11-28）。
 *
 * 上游语义（voice-menu.tsx）：**所有语音控制收进一个触发器**——听写、
 * 朗读回复、语音通话；触发器**报告最响的现场状态**（录音=方形/转写=转圈/
 * 否则麦克风；任一在活动 = 高亮），收起的菜单永远不会在麦克风开着时装死。
 *
 * 宿主差异：唤醒词（"hey hermes" 常听）未移植——WebView2 的连续识别
 * 不保证可用（未验证），先不做假开关；引擎选择行不在这里（宿主引擎写在
 * settings.json 的 voice 段，设置 → 语音配置有正经页面，菜单不复制第二个
 * 入口）；「开始语音通话」经 voiceLiveStore.requestCallToggle 交给列头
 * VoiceLiveButton（mic/凭据链在那边）。
 */
function ComposerVoiceMenu({
  supported,
  active,
  recording,
  transcribing,
  onToggleDictation,
}: {
  supported: boolean
  active: boolean
  recording: boolean
  transcribing: boolean
  onToggleDictation: () => void
}) {
  const autoSpeak = useAutoSpeakRepliesPref()
  const sessionUp = useVoiceLive((s) => s.sessionUp)
  // 任一语音面在活动 → 触发器高亮（hermes `active` 同语义）
  const lit = active || autoSpeak
  const label = recording
    ? '停止语音输入'
    : transcribing
      ? '转写中…'
      : '语音控制（听写 / 朗读回复 / 语音通话）'
  return (
    <ContextMenu align="end" anchor="trigger" side="top" sideOffset={6}>
      <ContextMenuTrigger>
        <button
          type="button"
          aria-label={label}
          title={label}
          data-slot="composer-voice-menu-trigger"
          className={
            lit
              ? `${inkButton} pressable-sm flex size-[28px] shrink-0 items-center justify-center rounded-full`
              : `${ghostButton} pressable-sm size-[28px] shrink-0`
          }
        >
          {recording ? (
            <SquareIcon className="size-[var(--size-icon-sm)] fill-current" />
          ) : transcribing ? (
            <Loader2Icon className="size-[var(--size-icon-sm)] animate-spin" />
          ) : (
            <MicIcon className="size-[var(--size-icon-lg)]" />
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-52" ariaLabel="语音控制">
        <ContextMenuItem
          onSelect={() => voiceLiveStore.getState().requestCallToggle()}
        >
          <PhoneIcon className="size-[var(--size-icon-md)]" />
          {sessionUp ? '结束语音通话' : '开始语音通话'}
        </ContextMenuItem>
        <ContextMenuSeparator />
        {/* 复选行（hermes 注释：三项都是"用户要看当前状态"的开关，普通行
            会把状态折进菜单里）；选中不关菜单——听写是要看着录音状态的
            模式（hermes `event.preventDefault()` 同款，走 closeOnSelect=false）。 */}
        {supported && (
          <ContextMenuCheckboxItem
            checked={active}
            closeOnSelect={false}
            disabled={transcribing}
            onCheckedChange={() => onToggleDictation()}
            title={transcribing ? '转写收尾中，稍候再操作' : undefined}
          >
            {recording ? '停止听写' : transcribing ? '转写中…' : '语音听写'}
          </ContextMenuCheckboxItem>
        )}
        <ContextMenuCheckboxItem
          checked={autoSpeak}
          closeOnSelect={false}
          onCheckedChange={(v) => voicePrefsStore.getState().setAutoSpeak(v)}
        >
          {autoSpeak ? (
            <Volume2Icon className="size-[var(--size-icon-md)]" />
          ) : (
            <VolumeXIcon className="size-[var(--size-icon-md)]" />
          )}
          {autoSpeak ? '停止朗读回复' : '朗读回复'}
        </ContextMenuCheckboxItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function ComposerWired() {
  const input = unstable_useComposerInput()
  // 终端式输入历史（assistant-ui 原语，2026-11-28）：空草稿时 ↑ 召回最近
  // 发送的消息、↓ 回退并恢复原草稿；由原语自己避让 slash/@ 菜单（它只看
  // defaultPrevented 与光标行，宿主只需先跑自己的处理器）。
  const inputHistory = unstable_useComposerInputHistory()
  const aui = useAui()
  const value = input.value
  const isRunning = useAuiState((s) => s.thread.isRunning)
  // 运行中仍可提交（排队），附件也算内容——不能只看文本
  const composerAttachmentCount = useAuiState((s) => s.composer.attachments.length)
  const canQueueWhileRunning = value.trim().length > 0 || composerAttachmentCount > 0
  const threadIdFromAui = useAuiState((s) => s.threadListItem.id)
  // 分栏 runtime 没有 threadListAdapter（threadListItem.id 恒为
  // DEFAULT_THREAD_ID）——pane 显式提供的落盘 id 优先；主 pane 走 aui 兜底。
  // assistant-ui 的占位 id（external-store / local 两套常量）归一成 null：
  // 新草稿不属于任何会话。
  const scopedThreadId = useThreadSessionId()
  const threadId =
    scopedThreadId ??
    (threadIdFromAui === 'DEFAULT_THREAD_ID' || threadIdFromAui === '__DEFAULT_ID__'
      ? null
      : threadIdFromAui)
  const setText = input.setText

  // ── composer 草稿（按会话持久化，2026-11-28 用户："输入框里的消息，
  //    切换会话后都没了，关闭重启应用也没了"）——hermes
  //    composer-draft-stash 对偶：键 = sessionThreadKey(threadId)（New
  //    Chat = 哨兵键），localStorage 恢复/防抖 stash。
  //    **切键首帧必须跳过 stash**：此刻 value 还是旧会话文本，直接写会把
  //    A 的草稿落进 B 的键——只做恢复（setText 新键草稿）。
  const lastDraftKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (lastDraftKeyRef.current !== threadId) {
      lastDraftKeyRef.current = threadId
      setText(getComposerDraft(threadId))
      return
    }
    const timer = window.setTimeout(() => setComposerDraft(threadId, value), 400)
    return () => window.clearTimeout(timer)
  }, [threadId, value, setText])

  const slash = useSlashMatches(value, COMMANDS)
  // @ 补全：静态行（宿主自带占位人员）+ `composer.atCompletions` 贡献行
  // （hermes-bots 的机器人 handle）。上游语义：贡献行排在宿主行**之前**，
  // 贡献声明的 handles 压掉同名宿主行（防重复）；单个源抛错只丢该源的行。
  const atCompletions = useContributions(COMPOSER_AT_COMPLETIONS_AREA)
  const mentions = useMemo<ComposerPerson[]>(() => {
    const match = /@([\w@.-]*)$/.exec(value)
    if (!match) return []
    const query = (match[1] ?? '').toLowerCase()
    const rows: ComposerPerson[] = []
    const seen = new Set<string>()
    const claimed = new Set<string>()
    for (const contribution of atCompletions) {
      const provide = (contribution.data as { provide?: unknown } | undefined)?.provide
      if (typeof provide !== 'function') continue
      try {
        const items = (provide as (q: string) => unknown)(query)
        if (!Array.isArray(items)) continue
        for (const raw of items) {
          const item = raw as { handles?: unknown; insert?: unknown }
          const insert = typeof item?.insert === 'string' ? item.insert.trim() : ''
          if (!insert) continue
          const name = insert.replace(/^@/, '')
          if (!name || seen.has(name)) continue
          seen.add(name)
          rows.push({ name, role: 'agent' })
          if (Array.isArray(item.handles)) {
            for (const handle of item.handles) claimed.add(String(handle).toLowerCase())
          }
        }
      } catch (e) {
        console.error(`[composer] @ 补全源 ${contribution.id} 抛错——丢弃该源的行`, e)
      }
    }
    for (const person of PEOPLE) {
      if (!person.name.toLowerCase().startsWith(query)) continue
      if (claimed.has(`@${person.name.toLowerCase()}`)) continue
      if (seen.has(person.name)) continue
      seen.add(person.name)
      rows.push({ name: person.name, role: person.role })
    }
    return rows
  }, [atCompletions, value])
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

  // pi 控制面：模型目录 + 当前选中（model-catalog-store 共享投影——
  // regenerate-menu「换模型重生成」同源消费）。目录挂载时拉取（store 内
  // 带进程缓存）；state 随 isRunning 变化重拉（会话按需创建后 trigger 自动
  // 从 "Select model" 点亮为真名）。错误即错误：目录/状态拉取失败 console
  // 可见，不假装成功（目录空 = 错误态）；首条消息前 pi_get_state 报
  // no active session 是预期域状态（会话按需创建），不是被吞的错误。
  const entries = useStore(modelCatalogStore, (s) => s.entries)
  const models = useMemo<ModelOption[]>(() => toModelOptions(entries), [entries])
  const currentModel = useStore(modelCatalogStore, (s) => s.currentModel)
  // 思考档位（pi ThinkingLevel：off/minimal/low/medium/high/xhigh/max；
  // 不在 DEFAULT_EFFORT_OPTIONS 内的值 resolveEffort 落空 = 不选中）
  const [currentEffort, setCurrentEffort] = useState<string | null>(null)
  const { usage } = useUsageBridge()
  useEffect(() => {
    void modelCatalogStore.getState().load()
  }, [])
  useEffect(() => {
    let cancelled = false
    void invoke<{ provider: string; modelId: string; thinkingLevel: string | null }>('pi_get_state')
      .then((st) => {
        if (!cancelled) {
          // 当前选中模型写共享 store（regenerate-menu 的 currentId 同源）
          modelCatalogStore.getState().setCurrentModel(`${st.provider}/${st.modelId}`)
          // 思考档位随 state 回读（pi_get_state.thinkingLevel）
          setCurrentEffort(st.thinkingLevel ?? null)
        }
      })
      .catch((e) => {
        // 首条消息前必然发生（无会话=预期域状态）；其余失败照常可见。
        // 后端错误文案是中文「无活动会话」（pi_session::live），历史代码
        // 只认英文 "no active session" → 永远走"其它失败"分支 return，
        // 默认模型回填从不执行（输入框永远 "Select model"，2026-11-14
        // 实锤）。两种文案都认。
        const msg = String(e)
        if (!msg.includes('无活动会话') && !msg.includes('no active session')) {
          console.error('[pi] 会话状态获取失败', e)
          return
        }
        // **无会话时读 settings.json 的默认模型**（2026-10-26）：新建会话
        // 就是按这两个字段起跑的，所以它才是"下一条消息会用哪个模型"的
        // 真相。不读的话选择器会退回 models[0]（目录第一项）——用户看到的
        // 名字与实际将用的模型不是同一个，正是"模型选择是假的"的观感来源。
        // 键形式：rpi 只认 camelCase（defaultProvider/defaultModel，settings.rs
        // `rename_all = "camelCase"`）；snake_case 是旧 pi 时代遗留文档，
        // 双读只为兼容历史文件（写盘一律 camelCase，见 persist_default_model）。
        void invoke<{
          defaultProvider?: string
          defaultModel?: string
          default_provider?: string
          default_model?: string
        } | null>('pi_get_settings')
          .then((settings) => {
            if (cancelled) return
            const p = settings?.defaultProvider ?? settings?.default_provider
            const m = settings?.defaultModel ?? settings?.default_model
            if (p && m) modelCatalogStore.getState().setCurrentModel(`${p}/${m}`)
          })
          .catch((e2) => {
            console.error('[pi] 读取默认模型失败', e2)
          })
      })
    return () => {
      cancelled = true
    }
  }, [isRunning])
  const [modelError, setModelError] = useState<string | null>(null)
  const onModelChange = useCallback((id: string) => {
    // provider 不含 '/'，model id 可能含（HF 风格 meta-llama/Llama-3）——
    // 必须按第一个 '/' 切分；split('/') 会截断 modelId（审查 #1 实锤）。
    const idx = id.indexOf('/')
    if (idx <= 0) {
      setModelError(`模型标识无效：${id}`)
      return
    }
    const provider = id.slice(0, idx)
    const modelId = id.slice(idx + 1)
    // 错误即错误：set_model 成功才更新选中态，失败保持原值且错误可见
    // ——不乐观更新（UI 假装切换成功 = 兜底）。
    //
    // 2026-10-26：失败此前只 console.error，用户界面上完全看不到（"选了
    // 没反应"）。现在错误上到工具栏的 modelError，选择器旁边可见。
    setModelError(null)
    void invoke('pi_set_model', { provider, modelId })
      .then(() => modelCatalogStore.getState().setCurrentModel(id))
      .catch((e) => {
        console.error(`[pi] set_model ${id} 失败（保持原选择）`, e)
        setModelError(`切换模型失败：${String(e)}`)
      })
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
  // ── 附件选择（2026-11-15）──────────────────────────────────────────────
  // 不用 assistant-ui 的 HTML `<input type=file>`：那条路只能拿到 File 字节，
  // 拿不到本地路径——视频/音频/文档要靠「绝对路径 + 模型用工具读」的通道
  // （引擎没有这些原生多模态块）。原生对话框直给路径，图片再预读 data URL
  // 走引擎原生图片通道。选择/读取失败在输入框下方红字可见（不静默）。
  const [attachError, setAttachError] = useState<string | null>(null)
  const [pickingAttachments, setPickingAttachments] = useState(false)
  const onPickAttachments = useCallback(async () => {
    if (pickingAttachments) return
    setPickingAttachments(true)
    setAttachError(null)
    try {
      const files = await pickAttachmentFiles()
      for (const file of files) await aui.composer.addAttachment(file)
    } catch (e) {
      console.error('[composer] 选择附件失败', e)
      setAttachError(`添加附件失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPickingAttachments(false)
    }
  }, [aui, pickingAttachments])
  // 当前模型的上下文窗口（用量环分母）——目录缺失或 <=0 时不渲染
  // ContextDisplay.Bar：旧写法 ?? 0 会除零 → Infinity → clamp 100 =
  // 红环误报（审查 #7）。
  const currentContextWindow = currentModel
    ? entries.find((e) => `${e.provider}/${e.id}` === currentModel)?.contextWindow
    : undefined

  /** 上下文环就地设置总量：写 models.json 的 models[].contextWindow，再强制
   *  重拉目录（环/百分比立刻收敛）。窗口未知不再是死胡同。 */
  const setContextWindow = useCallback(
    async (tokens: number) => {
      if (!currentModel) throw new Error('当前模型未知，无法写入上下文窗口')
      const slash = currentModel.indexOf('/')
      if (slash <= 0 || slash === currentModel.length - 1) {
        throw new Error(`模型键格式异常：${currentModel}`)
      }
      const providerId = currentModel.slice(0, slash)
      const modelId = currentModel.slice(slash + 1)
      const doc = await invoke<Record<string, unknown> | null>('pi_get_models_config')
      if (doc === null || typeof doc !== 'object') {
        throw new Error('models.json 为空：先在设置 → 模型 → 服务商里添加该服务商')
      }
      const next = structuredClone(doc)
      const providers = next['providers']
      if (typeof providers !== 'object' || providers === null) {
        throw new Error('models.json 缺 providers 表')
      }
      const provider = (providers as Record<string, unknown>)[providerId]
      if (typeof provider !== 'object' || provider === null) {
        throw new Error(`models.json 里没有服务商 ${providerId}`)
      }
      const models = (provider as Record<string, unknown>)['models']
      if (!Array.isArray(models)) {
        throw new Error(`服务商 ${providerId} 的 models 不是数组`)
      }
      let hit = models.find(
        (m) => typeof m === 'object' && m !== null && (m as Record<string, unknown>)['id'] === modelId,
      )
      if (hit === undefined) {
        hit = { id: modelId }
        models.push(hit)
      }
      ;(hit as Record<string, unknown>)['contextWindow'] = tokens
      await invoke('pi_set_models_config', { value: next })
      await modelCatalogStore.getState().reload()
    },
    [currentModel],
  )

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
        if (p) setText(applyMentionRow(value, p.name))
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setDismissed(value)
      }
    }
    // ZCode：运行中 Enter = 提交后续修改。核心的默认 Enter 提交在
    // running && !capabilities.queue 时直接 return——这里绕过原语禁用，
    // 直接 composer.send() → runtime.onNew 按「交互行为」分流
    // （guide → pi_steer 注入当前 run；queue → 本地队列）。
    // 带 Ctrl/Cmd 的组合键留给 assistant-ui 原生 steer 热键（ComposerInput
    // 的 Cmd/Ctrl+Shift+Enter），这里不拦，否则会提前吃掉那次提交。
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.nativeEvent.isComposing &&
      isRunning
    ) {
      e.preventDefault()
      aui.composer.send()
    }
  }

  return (
    <ComposerPrimitive.Root asChild>
      {/* max-w-none：官方 Composer kit 自带 max-w-lg（512px）第二层收窄，
          与 thread 的 44rem 消息区叠层——输入框比消息区窄一截（实测 480 vs
          660）。twMerge 下 max-w-none 覆盖 kit 默认，宽度全权归外层。 */}
      <Composer className="w-full max-w-none">
        {/* 容器：paper 面 + rounded-[20px]（用户 2026-10-05：24→20）+ p-2.5 + gap-2 */}
        <ComposerPrimitive.AttachmentDropzone asChild>
          <ComposerBar>
            {/* 上游 composer.top 贡献槽（hermes-bots 的「等待队友」条挂这里）：
                输入上方的 banner，无贡献时不渲染。 */}
            <ComposerTopSlot sessionId={threadId} />
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
                    onClick={() => setText(applyMentionRow(value, p.name))}
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
                className="max-h-40 min-h-[40px] w-full resize-none bg-transparent p-0 text-[length:var(--conversation-text-font-size)] leading-[20px] text-(--text) outline-none placeholder:text-(--text-4)"
                enterKeyHint="send"
                onKeyDown={(e) => {
                  onInputKeyDown(e)
                  inputHistory.onKeyDown(e)
                }}
                placeholder={
                  isRunning ? '继续输入以排队后续修改' : '输入消息，/ 指令，@ 成员…'
                }
                rows={1}
              />
            )}
            {/* 官方工具行：左附件钮 / 右动作组（模型触发器 → 语音钮 →
                上下文环 → 发送/停止），顺序照 /elements/composer */}
            <ComposerToolbar>
              {/* 左组（2026-11-01 用户："不在加号后面在中间了"）：ComposerToolbar
                  是 justify-between——附件钮与模式钮必须包成一个组才贴左，
                  否则第二个子元素被推到行中 */}
              <div className="flex shrink-0 items-center gap-[4px]">
                {/* 原生选择器（图片/视频/音频/文档）：HTML input 拿不到本地
                    路径，视频/文档无法据此构造文件引用。 */}
                <ComposerAttachButton
                  aria-label="添加附件"
                  disabled={pickingAttachments}
                  title="添加图片 / 视频 / 音频 / 文档"
                  onClick={() => void onPickAttachments()}
                />
                {/* ZCode 同位的模式芯片（计划/确认/自主/完全访问）。rpi 只有
                    plan-mode 插件态 + permission-gate 启动开关，没有运行时
                    切换面——芯片只读展示当前真实模式，菜单里其余态置灰并
                    标注原因（不造假开关）。 */}
                <PermissionModeChip threadId={threadId ?? undefined} running={isRunning} />
                {/* 思考强度按钮（2026-11-27 用户：「输入框中还少个思考强调的
                    按钮，可以用 ass 组件自带的」）。

                    为什么需要独立入口：此前思考档位**只**藏在模型选择器的
                    下拉里，而且只在模型声明 `reasoning` 时才出现
                    （model-catalog-store 的 `...e.reasoning ? {efforts:true}`）
                    ——非推理模型、或用户没展开模型菜单时，根本看不到/找不到
                    这个能力。

                    数据面与模型选择器**完全同一份**（pi_set_thinking_level +
                    pi_get_state 回读），不是第二个真相；只是把它提到工具栏上
                    常驻可见。档位/中文名取 pi 真实 ThinkingLevel。 */}
                <ThinkingEffortButton
                  effort={currentEffort}
                  onChange={onEffortChange}
                />
                {/* 实时活动徽标（ZCode ConversationBackgroundWorkTrigger 同位）：
                    有运行中的终端/工作流/智能体时出现，点击直达详情或展开
                    状态面板；计数与面板分区同一份真值。 */}
                <ComposerStatusBadge />
              </div>
              <ComposerActions>
                {/* 上下文明细按钮（ZCode 同位：模型选择器左侧；2026-11-01
                    用户："模型选择的左边加个上下文的按钮"）。点击弹明细卡
                    （Input/Cached/Output/Reasoning 分解）。**常驻**：窗口未知
                    （models.json 没写 contextWindow，rpi 返回 0）也渲染——环
                    显示 0%，弹层写明"窗口未知"并指到设置；隐藏等于用户永远
                    看不到入口（2026-11-15 用户："zcode 中都能显示"）。 */}
                <ContextDisplay.Button
                  modelContextWindow={currentContextWindow ?? 0}
                  onSetContextWindow={setContextWindow}
                  usage={
                    usage
                      ? {
                          totalTokens: usage.totalTokens,
                          inputTokens: usage.inputTokens,
                          cachedInputTokens: usage.cachedInputTokens,
                          outputTokens: usage.outputTokens,
                        }
                      : undefined
                  }
                />
                <ModelSelector
                  align="end"
                  // ZCode 实测（9444）：模型触发器 28 高、圆角 8、14px 字、px-2；
                  // 不是胶囊（旧值 rounded-full 会盖掉组件内的 rounded-md）。
                  //
                  // 窄卡片折叠（2026-11-15，ZCode `@xl/composer` 断点）：
                  // 触发器是**唯一可收缩项**（其余按钮 shrink-0）——宽态
                  // 封顶 320px（默认字号下 deepseek-v4.1-flash-1017 这类长名
                  // 仍完整显示），卡片 < 36rem 收到 160px + 隐藏思考档位，
                  // < 24rem 只留 96px 短名。宽态不要用 200px：正常桌面宽度
                  // 也会把模型名截成 "deepseek-v4.1-flash-1…"（用户实报）。
                  // `[&>button]:min-w-0`：motion PopoverTrigger 里还有一层裸
                  // button，默认 min-width:auto 会让内部长名拒绝收缩。
                  className="h-[28px] max-w-[320px] min-w-0 shrink rounded-[8px] px-2 text-[14px] @max-xl/composer:max-w-[160px] @max-sm/composer:max-w-[96px] @max-sm/composer:[&>button>svg]:hidden [&>button]:min-w-0 [&>button]:max-w-full"
                  effort={currentEffort ?? ''}
                  models={models}
                  value={currentModel ?? undefined}
                  onEffortChange={onEffortChange}
                  onValueChange={onModelChange}
                  size="sm"
                  variant="ghost"
                />
                {/* 语音控制 = 一个菜单（hermes VoiceMenu 同位）：听写 /
                    朗读回复 / 语音通话。2026-11-28 前是裸听写钮——现在
                    触发器照旧可见（录音=方形/转写=转圈/活动=高亮），点击
                    展开全部语音开关（用户："能对应的全部接线"）。 */}
                <ComposerVoiceMenu
                  supported={dictation.supported}
                  active={dictation.active}
                  recording={dictation.recording}
                  transcribing={dictation.transcribing}
                  onToggleDictation={() => {
                    if (dictation.recording) dictation.stop()
                    else if (dictation.transcribing) dictation.cancel()
                    else dictation.start()
                  }}
                />
                {/* 右侧原 Ring 已撤（2026-11-01）：上下文入口统一到模型选择器
                    左侧的明细按钮（同一信息的第二个入口是噪声）。 */}
                {isRunning ? (
                  canQueueWhileRunning ? (
                    /* 运行中且有草稿：主钮 = 排队发送，**旁边多一个次要停止钮**。
                       ZCode 的口径是“有草稿时只显示排队，停止交给 Esc”——但用户
                       2026-11-27 实报「任务执行过程中…没法…停掉正在进行的任务」：
                       需要输入时囗口有字，停止钮就消失，而 Esc 这个隐性快捷键
                       无从得知。所以这里把停止做成可见的次要图标钮（不再是两个
                       主按钮，不违反“不能两个黑按钮”的原约束）。 */
                    <div className="flex items-center gap-1">
                      <ComposerPrimitive.Cancel asChild>
                        <button
                          type="button"
                          aria-label="停止生成"
                          title="停止生成"
                          className="text-(--text-3) hover:text-(--text-1) flex size-[28px] shrink-0 items-center justify-center rounded-[8px] transition-colors"
                        >
                          <SquareIcon className="size-[12px]" />
                        </button>
                      </ComposerPrimitive.Cancel>
                      <ComposerSend
                        aria-label="排队消息"
                        idle={false}
                        streaming={false}
                        onClick={() => aui.composer.send()}
                      />
                    </div>
                  ) : (
                    <ComposerPrimitive.Cancel asChild>
                      <ComposerSend aria-label="停止生成" idle={false} streaming />
                    </ComposerPrimitive.Cancel>
                  )
                ) : (
                  <ComposerPrimitive.Send asChild>
                    <ComposerSend aria-label="发送" idle={!value.trim()} streaming={false} />
                  </ComposerPrimitive.Send>
                )}
              </ComposerActions>
            </ComposerToolbar>
            {/* 模型切换失败必须可见（规矩 12：错误就是错误）——此前
                只进 console，用户看到的只是"选了没反应"。2026-11-15 挪出
                工具行：它是可变长文本，留在行内会在窄卡片里把发送钮挤出
                输入框；独立一行（truncate）既不撑破卡片也不隐藏错误。 */}
            {modelError && (
              <p
                className="text-destructive w-full min-w-0 truncate px-1 text-[11px] leading-4"
                role="alert"
                title={modelError}
              >
                {modelError}
              </p>
            )}
            {attachError && (
              <p
                className="text-destructive w-full min-w-0 truncate px-1 text-[11px] leading-4"
                role="alert"
                title={attachError}
              >
                {attachError}
              </p>
            )}
          </ComposerBar>
        </ComposerPrimitive.AttachmentDropzone>
        {/* 会话统计条（DSH StatsPills 的宿主形态，2026-11-27）：挂在输入卡
            下方（用户：「dsh 的输入框下面的第几轮对话、首吐多久、缓存命中
            的那个组件能完整移植过来使用吗」）。无数据时组件自己返回 null。
            **必须在 Dropzone 之外**：Dropzone 是 `asChild`（Radix Slot）——
            只接受单子元素，塞第二个子节点会让整壳抛 "Slot failed to slot
            onto its children"（2026-11-28 启动崩溃实锤，它曾放在
            </ComposerBar> 之后、Dropzone 之内）。 */}
        <ComposerStatsLine className="mt-1.5" />
      </Composer>
    </ComposerPrimitive.Root>
  )
}
