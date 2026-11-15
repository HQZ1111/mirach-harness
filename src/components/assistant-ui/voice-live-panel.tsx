/**
 * 双工语音入口 + 字幕条（GPT-Live WebRTC 桥 + MOSS Live WSS 桥共用，
 * 2026-11-11/12；2026-11-14 用户定稿"入口放项目名右边，像微信语音通话钮"）：
 *
 * 1. **VoiceLiveButton**：**列头 workspace 行**（ChatTabLabel 双行块的项目名
 *    右侧）的语音钮。点击：状态拉取 → 按 `voice.voice_chat_mode` 分流——
 *    `moss-live` 走 MossLiveSession（模思 WSS，mossAvailable 判定）、
 *    `gpt-live` 走 VoiceLiveSession（OpenAI WebRTC，available 判定）；
 *    均未配置红显 reason（经 store.error，字幕条消费）。
 * 2. **VoiceLivePanel**：composer 上方的字幕条（听/说状态 + 字幕 + 静音/
 *    关闭钮 + 红显）。按钮与字幕条分离挂载（钮在列头、字幕条在 composer），
 *    跨组件传话走 voiceLiveStore（error/session 态），不走 React ref。
 *    字幕语义按桥分流（GPT-Live delta 拼接 / MOSS 全文覆盖）。
 *
 * 委托回路（voice → agent turn → commentary 回读）= 驱动组件
 * voice-live-conversation.tsx（provider 内常驻），两个传输共用。
 */
import { FC, useEffect, useRef, useState } from 'react'
import { MicIcon, MicOffIcon, PhoneIcon, PhoneOffIcon, SquareIcon } from 'lucide-react'
import { useAui } from '@assistant-ui/react'

import { MossLiveSession } from '@/lib/moss-live'
import { MossToolFlow } from '@/lib/moss-tool-flow'
import { executeVoiceTool, MOSS_VOICE_TOOLS } from '@/lib/moss-tools'
import { VoiceLiveSession, delegationPrompt, toLiveHistory } from '@/lib/voice-live'
import { isVoiceStopCommand } from '@/lib/voice-stop-word'
import { cn } from '@/lib/utils'

import { foldTranscriptForSeed } from './voice-live-conversation'
import {
  getActiveSession,
  setActiveSession,
  useVoiceLive,
  voiceLiveStore,
} from './voice-live-store'

/** 语音钮（列头 workspace 行，项目名右侧）。无后端面时按钮照常渲染（可点
 *  → 错误可见），不提前隐藏——hermes 的隐藏规则针对引擎选择菜单，宿主单引擎。 */
export const VoiceLiveButton: FC = () => {
  const sessionUp = useVoiceLive((s) => s.sessionUp)
  const [busy, setBusy] = useState(false)
  // 口语停止词的 utterance 累积 + 1.5s 安静判定（hermes onTranscript
  // :254-275：语音模型自己不委托裸 stop，转写文本停下后判）
  const userUtteranceRef = useRef('')
  const utteranceTimerRef = useRef<null | number>(null)
  const aui = useAui()

  // 卸载时兜底拆会话（页面切走/组件卸载不留活轨）
  useEffect(() => {
    return () => {
      getActiveSession()?.close()
      setActiveSession(null)
      voiceLiveStore.getState().setSessionUp(false)
    }
  }, [])

  const stop = () => {
    if (utteranceTimerRef.current) {
      window.clearTimeout(utteranceTimerRef.current)
      utteranceTimerRef.current = null
    }
    userUtteranceRef.current = ''
    getActiveSession()?.close()
    setActiveSession(null)
    voiceLiveStore.getState().setSessionUp(false)
    voiceLiveStore.getState().clearCaptions()
  }

  const start = async () => {
    if (busy || getActiveSession()) return
    setBusy(true)
    voiceLiveStore.getState().setError(null)
    try {
      const status = await (await import('@/lib/voice-live')).fetchVoiceLiveStatus()
      if (status === null) {
        voiceLiveStore
          .getState()
          .setError('语音桥未加载（应用二进制无 pi_voice_live）——重新构建后重试。')
        return
      }
      const store = voiceLiveStore.getState()
      // 字幕/停止词/委托的公共接线（两个传输共用；差异 = 字幕覆盖语义 +
      // 委托载荷形状 + 会话类）
      const wireUtterance = (session: object) => {
        if (utteranceTimerRef.current) {
          window.clearTimeout(utteranceTimerRef.current)
        }
        utteranceTimerRef.current = window.setTimeout(() => {
          utteranceTimerRef.current = null
          const utterance = userUtteranceRef.current
          userUtteranceRef.current = ''
          if (getActiveSession() === session && isVoiceStopCommand(utterance)) {
            stop()
          }
        }, 1500)
      }
      const isMoss = status.mode === 'moss-live'

      if (isMoss) {
        // ── MOSS Live（模思 WSS 桥）──
        if (!status.mossAvailable) {
          store.setError(
            status.mossReason ?? 'MOSS Live 未配置（voice.moss_live.api_key 或 MOSS_API_KEY）',
          )
          return
        }
        const session = new MossLiveSession({
          onTranscript: (speaker, text) => {
            // MOSS transcript 是全文覆盖语义
            store.setCaption(speaker, text)
            if (speaker !== 'user') return
            userUtteranceRef.current = text
            wireUtterance(session)
          },
          onDelegation: (delegationId, info) => {
            if (getActiveSession() !== session) return
            if (info.objective && isVoiceStopCommand(info.objective)) {
              stop()
              return
            }
            store.setPendingDelegation({
              delegationId,
              prompt: info.objective,
              voiceContext: info.context.join('\n'),
            })
          },
          onError: (message) => store.setError(message),
          onClosed: (reason) => {
            setActiveSession(null)
            store.setSessionUp(false)
            // 断线可见（规矩 12）：vendor/传输发起的关闭如实红显——用户主动
            // stop() 的拆除走 finalized 守卫，不会到达这里（moss-live.ts）
            store.setError(`语音会话已断开：${reason}`)
          },
          onSpeakingChange: (speaking) => store.setSpeaking(speaking),
        })
        setActiveSession(session)
        store.setSessionUp(true)
        store.clearCaptions()
        // 工具面（host 原生只读集 + run_cron_job_now）：执行器错误经
        // 失败输出交回模型如实转述，告警走 onError 非致命通道
        session.attachToolFlow(
          new MossToolFlow({
            tools: MOSS_VOICE_TOOLS,
            executor: executeVoiceTool,
            send: (event) => session.sendRawEvent(event),
            onNotice: (message) => store.setError(message),
          }),
        )
        await session.start()
      } else {
        // ── GPT-Live（OpenAI WebRTC 桥）──
        if (status.mode === 'chained') {
          store.setError('链式模式没有语音（STT/TTS 提供方未接通）——在设置 → 语音切 GPT-Live 或 MOSS-Live。')
          return
        }
        if (!status.available) {
          store.setError(status.reason ?? 'gpt-live 未启用（voice.voice_chat_mode）')
          return
        }
        const session = new VoiceLiveSession({
          onTranscript: (fragment) => {
            store.pushCaption(fragment.speaker, fragment.text)
            // 口语停止词（hermes :254-275）：用户片段累积，1.5s 安静后整句判定
            if (fragment.speaker !== 'user') {
              return
            }
            userUtteranceRef.current += fragment.text
            wireUtterance(session)
          },
          onDelegation: (delegationId, context) => {
            if (getActiveSession() !== session) {
              return
            }
            // 片段流折轮（hermes :299 delegationPrompt）→ 停止词判 → 提交
            const { context: voiceContext, prompt } = delegationPrompt(context)
            if (prompt && isVoiceStopCommand(prompt)) {
              stop()
              return
            }
            store.setPendingDelegation({ delegationId, prompt, voiceContext })
          },
          onError: (message) => {
            store.setError(message)
          },
          onClosed: () => {
            setActiveSession(null)
            store.setSessionUp(false)
          },
          onSpeakingChange: (speaking) => {
            store.setSpeaking(speaking)
          },
        })
        setActiveSession(session)
        store.setSessionUp(true)
        store.clearCaptions()
        // 种子 history：当前 thread 的文本 turn（hermes seedHistory 同位——
        // live 模型带着文字对话的上下文开始说话）
        const seed = toLiveHistory(foldTranscriptForSeed(aui.thread.getState().messages))
        await session.start(seed)
      }
    } catch (e) {
      setActiveSession(null)
      voiceLiveStore.getState().setSessionUp(false)
      voiceLiveStore.getState().setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      aria-label={sessionUp ? '结束语音会话' : '开始语音会话'}
      className={cn(
        'pointer-events-auto flex size-7 shrink-0 items-center justify-center rounded-[4px] transition-colors',
        sessionUp
          ? 'text-rose-600 dark:text-rose-400'
          : 'text-muted-foreground hover:text-foreground',
      )}
      data-slot="voice-live-button"
      data-stub={sessionUp ? undefined : 'true'}
      onClick={() => (sessionUp ? stop() : void start())}
      title={
        sessionUp
          ? '结束语音会话'
          : '开始双工语音（GPT-Live / MOSS-Live——在设置 → 语音配置）'
      }
      type="button"
    >
      {sessionUp ? <PhoneOffIcon className="size-[18px]" /> : <PhoneIcon className="size-[18px]" />}
    </button>
  )
}

/** 字幕条（会话在场时挂 composer 上方；hermes status-stack 的语音字幕位）。
 *  红显 = store.error（入口钮在列头，跨组件经 store 传话）。 */
export const VoiceLivePanel: FC = () => {
  const sessionUp = useVoiceLive((s) => s.sessionUp)
  const speaking = useVoiceLive((s) => s.speaking)
  const muted = useVoiceLive((s) => s.muted)
  const captions = useVoiceLive((s) => s.captions)
  const error = useVoiceLive((s) => s.error)
  const activeDelegationId = useVoiceLive((s) => s.activeDelegationId)
  const pendingDelegation = useVoiceLive((s) => s.pendingDelegation)
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [captions.length])

  if (!sessionUp) {
    return error ? (
      <div
        className="text-rose-600 dark:text-rose-400 rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-xs dark:border-rose-800 dark:bg-rose-950/30"
        data-stub="true"
        role="alert"
      >
        {error}
        <button
          className="ml-2 underline"
          onClick={() => voiceLiveStore.getState().setError(null)}
          type="button"
        >
          知道了
        </button>
      </div>
    ) : null
  }

  return (
    <div
      className="border-border/70 rounded-md border bg-background/95 px-2.5 py-1.5"
      data-slot="voice-live-panel"
    >
      <div className="text-muted-foreground flex items-center gap-1.5 text-[0.625rem]">
        <span
          aria-hidden
          className={cn('size-1.5 rounded-full', speaking ? 'bg-emerald-500' : 'bg-muted-foreground/50')}
        />
        <span>{speaking ? '正在说话' : '聆听中'}</span>
        {/* 异步委托可见：语音模型把任务交给主代理后，麦克风照常开着，
            用户可以继续说话（新请求会接管在途 turn）。 */}
        {(activeDelegationId !== null || pendingDelegation !== null) && (
          <span className="text-foreground/70" data-slot="voice-live-delegation">
            主代理处理中…
          </span>
        )}
        <span className="flex-1" />
        <button
          aria-label={muted ? '解除静音' : '静音'}
          className="text-muted-foreground hover:text-foreground flex size-5 items-center justify-center rounded-[4px]"
          onClick={() => {
            const next = !muted
            voiceLiveStore.getState().setMuted(next)
            getActiveSession()?.setMuted(next)
          }}
          type="button"
        >
          {muted ? <MicOffIcon className="size-3" /> : <MicIcon className="size-3" />}
        </button>
        <button
          aria-label="结束语音会话"
          className="text-rose-600 hover:text-rose-500 flex size-5 items-center justify-center rounded-[4px]"
          onClick={() => {
            getActiveSession()?.close()
            setActiveSession(null)
            voiceLiveStore.getState().setSessionUp(false)
          }}
          type="button"
        >
          <SquareIcon className="size-3" />
        </button>
      </div>
      {captions.length > 0 && (
        <div className="mt-1 max-h-24 overflow-y-auto" ref={logRef}>
          {captions.map((c, i) => (
            <div
              className={cn(
                'text-xs',
                c.speaker === 'user' ? 'text-foreground' : 'text-muted-foreground',
              )}
              key={i}
            >
              {c.speaker === 'user' ? '你：' : '语音：'}
              {c.text}
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="text-rose-600 dark:text-rose-400 mt-1 text-xs" data-stub="true">
          {error}
        </div>
      )}
    </div>
  )
}
