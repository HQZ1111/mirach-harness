/**
 * 扩展 UI 请求卡片（docs/pi-integration.md §4.4 审批/问题卡前端）：
 * - confirm：批准（value=true）/ 拒绝（value=false）/ 取消（cancelled）；
 *   value 形状按上游约定 `Value::Bool(allow)`，"仅本次"（persist:false
   对象）随扩展生态出现后接入；
 * - 其他 method（select/input/notify…）：MVP 显示 method + payload，
 *   只提供取消——真实 payload 形状出现后按需补全，不做猜测 UI。
 */
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

import { dispatchNativeNotification } from '@/lib/native-notify'
import { approvalBridge, useApprovalBridge } from './approval-bridge'

export function ApprovalCards() {
  const { pending } = useApprovalBridge()
  const [busyId, setBusyId] = useState<string | null>(null)
  const notifiedRef = useRef<Set<string>>(new Set())

  // rpi 的审批请求是插件 runtime action（不进 AgentEvent 流），SSE 上没有
  // extension_ui_request 信号——挂载即拉一次 + 轮询（工具调用在审批前
  // 阻塞，卡片必须在那之前出现）。无会话时命令返回空数组。
  useEffect(() => {
    const refresh = () =>
      approvalBridge
        .getState()
        .refresh()
        .catch((err) => console.error('[pi] 审批列表拉取失败', err))
    refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => window.clearInterval(timer)
  }, [])

  // 新审批 = 需要人：窗口失焦时弹 OS 通知（同一条请求只提醒一次）。
  useEffect(() => {
    const fresh = pending.filter((req) => !notifiedRef.current.has(req.id))
    if (fresh.length === 0) return
    for (const req of fresh) notifiedRef.current.add(req.id)
    const head = fresh[0]!
    const detail = typeof head.payload === 'string' ? head.payload : JSON.stringify(head.payload)
    dispatchNativeNotification({
      kind: 'approval',
      title: '扩展审批请求',
      body: `${head.method}${head.extensionId ? ` · ${head.extensionId}` : ''}${detail ? ` — ${detail.slice(0, 120)}` : ''}`,
      tag: head.id,
    })
  }, [pending])

  if (pending.length === 0) return null

  const respond = async (id: string, value: unknown | null, cancelled: boolean) => {
    setBusyId(id)
    try {
      await invoke('pi_extension_ui_response', { id, value, cancelled })
    } catch (e) {
      // 错误即错误：应答失败错误可见，卡片保留可重试
      console.error('[pi] 审批应答失败', e)
    } finally {
      setBusyId(null)
      // 成功/失败都重拉挂起列表：Rust 端 ApprovalRegistry 是唯一真相
      // （应答落账/超时清理后残留卡自动消失——失败应答的卡也可能已被
      // registry 清理，前端不能靠本地状态猜）
      void approvalBridge
        .getState()
        .refresh()
        .catch((err) => console.error('[pi] 审批列表刷新失败', err))
    }
  }

  return (
    <div className="mb-3 flex flex-col gap-2">
      {pending.map((req) => {
        const busy = busyId === req.id
        // 去描边（用户 2026-10-14 全局去描边）：审批卡不留描边线——层次改阴影
        // （白卡垫在消息区浅调色层上，去线后需轻微抬升防融为一体）
        return (
          <div
            className="rounded-(--composer-radius) bg-(--surface) p-3 shadow-sm"
            key={req.id}
          >
            <div className="mb-1 flex items-center gap-2 text-xs text-(--text-3)">
              <span className="font-medium tracking-wide uppercase">扩展请求 · {req.method}</span>
              {req.extensionId && <span className="truncate">{req.extensionId}</span>}
            </div>
            <pre className="max-h-32 overflow-auto rounded bg-black/[0.04] p-2 text-xs break-all whitespace-pre-wrap text-(--text-2)">
              {typeof req.payload === 'string' ? req.payload : JSON.stringify(req.payload, null, 1)}
            </pre>
            <div className="mt-2 flex items-center gap-2">
              {req.method === 'confirm' && (
                <>
                  <button
                    className="rounded-full bg-(--fl-accent) px-3 py-1 text-xs text-white disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void respond(req.id, true, false)}
                    type="button"
                  >
                    批准
                  </button>
                  <button
                    className="rounded-full border border-(--stroke-soft) px-3 py-1 text-xs text-(--text-2) disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void respond(req.id, false, false)}
                    type="button"
                  >
                    拒绝
                  </button>
                </>
              )}
              <button
                className="rounded-full px-3 py-1 text-xs text-(--text-3) hover:text-(--text) disabled:opacity-50"
                disabled={busy}
                onClick={() => void respond(req.id, null, true)}
                type="button"
              >
                取消
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
