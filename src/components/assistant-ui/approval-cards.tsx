/**
 * 扩展 UI 请求卡片（docs/pi-integration.md §4.4 审批/问题卡前端）：
 * - confirm：批准（value=true）/ 拒绝（value=false）/ 取消（cancelled）；
 *   value 形状按上游约定 `Value::Bool(allow)`，"仅本次"（persist:false
   对象）随扩展生态出现后接入；
 * - 其他 method（select/input/notify…）：MVP 显示 method + payload，
 *   只提供取消——真实 payload 形状出现后按需补全，不做猜测 UI。
 */
import { useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

import { approvalBridge, useApprovalBridge } from './approval-bridge'

export function ApprovalCards() {
  const { pending } = useApprovalBridge()
  const [busyId, setBusyId] = useState<string | null>(null)

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
        return (
          <div
            className="rounded-(--composer-radius) border border-(--stroke-soft) bg-(--surface) p-3"
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
