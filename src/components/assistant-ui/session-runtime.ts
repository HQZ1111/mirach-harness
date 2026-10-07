/**
 * 会话分栏独立聊天运行时（v7.4 双对话分栏完整版，抄 hermes 会话瓦片）：
 * 每个会话窗格 = 自己的轮次机 + 自己的 per-thread SSE 流 + 自己的
 * composer/发送/中断——不再镜像全局活动会话。
 *
 * 与主 runtime（runtime.tsx，工作区）的分工：
 * - 工作区 = thread "main"（活动会话，全量管理功能：fork/检查点/队列/成本）
 * - 会话分栏 = thread = 自己的 sessionId（buffer 引擎侧本就 per-thread：
 *   ThreadBuffers 按线程分桶，POST 按线程入桶，GET ?thread=X 按线程 drain）
 *
 * 后端契约（v7.4 新增）：POST body 可带 sessionPath——引擎 flush 当前会话
 * 后切换到它再跑（引擎单 handle，切换与在跑 run 经 handle mutex 天然串行）；
 * 事件全部落 POST 线程的 buffer（ui_bridge 按 POST 线程创建）。工作区的
 * postRun 同样带自己的 sessionPath——跨分栏发送后下一次工作区发送会把引擎
 * 切回工作区会话。
 */
import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useRef } from 'react'
import {
  MessageNotSentError,
  useExternalStoreRuntime,
  type AppendMessage,
} from '@assistant-ui/react'
import { useActorRef, useSelector } from '@xstate/react'

import { turnMachine, type TurnContext } from './turn-actor'
import { convertTurnMessage, hydratePiMessages } from './pi-hydrate'
import { imageAttachmentAdapter, parseImageDataUrl, speechAdapter, type PiImagePayload } from './runtime'

export interface ThreadChatRuntimeOptions {
  /** 会话 id（= buffer/stream 键 = catalog entries 键） */
  threadId: string
  /** 会话文件路径（catalog；发送时随 POST 带给引擎切会话） */
  sessionPath: string | undefined
}

/** 会话分栏独立聊天运行时（AssistantRuntimeProvider 用）。 */
export function useThreadChatRuntime({ threadId, sessionPath }: ThreadChatRuntimeOptions) {
  const actorRef = useActorRef(turnMachine, {
    input: {
      messages: [],
      currentRunId: null,
      lastEventId: 0,
      error: null,
      usage: null,
      compaction: null,
      interrupted: false,
    } as TurnContext,
  })
  const compaction = useSelector(actorRef, (s) => s.context.compaction)
  const interrupted = useSelector(actorRef, (s) => s.context.interrupted)
  const messages = useSelector(actorRef, (s) => s.context.messages)
  const isRunning = useSelector(actorRef, (s) => s.matches('streaming'))

  // 水合：按会话文件路径读（真相在 pi；pi_get_session_messages 叶链还原
  // 当前分支）。挂载/路径变化各一次；流式增量走 SSE 不重读。
  const hydratedPathRef = useRef<string | null>(null)
  useEffect(() => {
    let dead = false
    if (!sessionPath) return
    if (hydratedPathRef.current === sessionPath) return
    hydratedPathRef.current = sessionPath
    void (async () => {
      try {
        const history = await invoke<Record<string, unknown>[]>('pi_get_session_messages', {
          path: sessionPath,
        })
        if (!dead) actorRef.send({ type: 'HYDRATE', messages: hydratePiMessages(history ?? []) })
      } catch (e) {
        console.error('[session-chat] 会话历史水合失败', e)
      }
    })()
    return () => {
      dead = true
    }
  }, [sessionPath, actorRef])

  // per-thread SSE：引擎本就按线程分桶（ThreadBuffers），每个会话一条流
  // 各自 drain 各自的桶——跨分栏零串扰。断线由浏览器带 Last-Event-ID 续放。
  const endpointRef = useRef<{ port: number; token: string } | null>(null)
  useEffect(() => {
    let es: EventSource | null = null
    let dead = false
    void (async () => {
      try {
        const ep = await invoke<{ port: number; token: string }>('get_agui_endpoint')
        if (dead) return
        endpointRef.current = ep
        let url = `http://127.0.0.1:${ep.port}/ag-ui/stream?thread=${encodeURIComponent(threadId)}&token=${encodeURIComponent(ep.token)}`
        try {
          const cursor = await invoke<number>('pi_stream_cursor', { thread: threadId })
          url += `&lastEventId=${cursor}`
        } catch (e) {
          console.error('[session-chat] 流游标获取失败（保留全量重放连接）', e)
        }
        if (dead) return
        es = new EventSource(url)
        es.onmessage = (e) => {
          try {
            const parsed = JSON.parse(e.data)
            actorRef.send({
              type: 'AGUI_EVENT',
              event: parsed as { type: string } & Record<string, unknown>,
              id: Number(e.lastEventId || 0),
            })
          } catch (err) {
            console.error('[session-chat] 事件解析失败', err)
          }
        }
        es.onerror = () => {
          // 浏览器自动重连（Last-Event-ID 续放）；连接态不另设投影
          //（分栏无状态栏，失败重连静默——engine 侧事件不丢）
        }
      } catch (e) {
        console.error('[session-chat] 流连接失败', e)
      }
    })()
    return () => {
      dead = true
      es?.close()
    }
  }, [threadId, actorRef])

  // 发送：POST 带 sessionPath——引擎 flush 当前会话切到本会话再跑（事件落
  // 本线程 buffer）。失败 console.error 可见（本 run 不发生）。
  const postRun = useCallback(
    (message: string, images?: PiImagePayload[]) => {
      const ep = endpointRef.current
      if (!ep) {
        console.error('[session-chat] endpoint 未就绪——消息未发送')
        return
      }
      void fetch(`http://127.0.0.1:${ep.port}/ag-ui?token=${encodeURIComponent(ep.token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId,
          message,
          ...(sessionPath ? { sessionPath } : {}),
          ...(images && images.length > 0 ? { images } : {}),
        }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`POST /ag-ui 失败: ${res.status}`)
        })
        .catch((e) => console.error('[session-chat] POST 失败', e))
    },
    [threadId, sessionPath],
  )

  // 发送入口（ComposerPrimitive.Send → runtime onNew）。本会话 run 进行中
  // fail loud（草稿回 composer）——引擎串行（prompt 持锁跨整个 run），另一
  // 分栏在跑时 POST 会阻塞到它收尾；排队面板是主会话管理功能，分栏不做
  // 静默排队（禁止静默兜底）。
  const onNew = useCallback(
    async (m: AppendMessage) => {
      const text = m.content
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('')
      if (!text) throw new MessageNotSentError('[session-chat] 消息为空：附件必须伴随文本 prompt 发送')
      const images: PiImagePayload[] = []
      for (const att of m.attachments ?? []) {
        for (const part of att.content) {
          if (part.type !== 'image') continue
          const parsed = parseImageDataUrl(part.image)
          if (!parsed) {
            console.error(`[session-chat] 附件 ${att.name} 的图片不在白名单——未随消息发送`)
            continue
          }
          images.push(parsed)
        }
      }
      if (!endpointRef.current) throw new Error('[session-chat] endpoint 未就绪，消息未发送')
      if (actorRef.getSnapshot().matches('streaming')) {
        throw new MessageNotSentError('[session-chat] 本会话上一条消息仍在运行——请稍候再发')
      }
      actorRef.send({
        type: 'USER_SUBMIT',
        text,
        messageId: `user-${Date.now()}`,
      })
      postRun(text, images)
    },
    [actorRef, postRun],
  )

  // 中断：pi_interrupt 是引擎级（单 run）——仅本会话确实在跑时才允许
  // （不打断别的分栏/工作区的 run）。
  const onCancel = useCallback(async () => {
    if (!actorRef.getSnapshot().matches('streaming')) return
    try {
      await invoke('pi_interrupt')
      actorRef.send({ type: 'CANCEL_MARK' })
    } catch (e) {
      console.error('[session-chat] interrupt 失败', e)
    }
  }, [actorRef])

  const runtime = useExternalStoreRuntime({
    // adapter 面 = 主 runtime 同款（attachments 白名单/朗读；模型目录是
    // 引擎级控制面，ModelSelector 全局共享）。convertMessage 单源
    // （pi-hydrate.convertTurnMessage——主/分栏防漂移）。state 投影：
    // 压缩横幅/中断态走本分栏自己的轮次机 context。
    adapters: {
      attachments: imageAttachmentAdapter,
      ...(speechAdapter ? { speech: speechAdapter } : {}),
    },
    convertMessage: convertTurnMessage,
    state: { compaction, interrupted },
    messages,
    isRunning,
    onNew: onNew as (m: AppendMessage) => Promise<void>,
    onCancel,
  })
  return runtime
}
