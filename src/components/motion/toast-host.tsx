/**
 * 全局 toast 宿主（2026-11-18）：`host.notify` / `host.notifyError` 的可见面。
 *
 * 背景（审计实锤）：插件约 50 个 notify / 16 个 notifyError 调用点此前只落
 * `console.log/error`（或权限允许时的浏览器 Notification）——用户看不到任何
 * 提示（"点了没反应"的主要来源之一）。这里把 beui 的 AnimatedToastStack
 * 挂到应用根，host shim 经 `window` 自定义事件 `mirach:toast` 投递。
 *
 * 事件 detail（全部可选）：`{kind?: 'error'|'warning'|'info'|'success',
 * title?: string, message: string, detail?: string, persistent?: boolean}`
 * ——形状与 hermes `host.notify(input)` 的入参同源并集。
 */
import { useEffect } from 'react'

import { AnimatedToastStack, useAnimatedToastStack, type ToastStatus } from './animated-toast-stack'

export interface MirachToastDetail {
  kind?: string
  title?: string
  message?: string
  detail?: string
  persistent?: boolean
}

export function ToastHost() {
  const stack = useAnimatedToastStack({ defaultDuration: 5200, limit: 5 })
  const { showToast } = stack

  useEffect(() => {
    const onToast = (event: Event) => {
      const payload = (event as CustomEvent<MirachToastDetail>).detail ?? {}
      const message = String(payload.message ?? '').trim()
      if (!message) return
      const status: ToastStatus =
        payload.kind === 'error'
          ? 'error'
          : payload.kind === 'success'
            ? 'success'
            : payload.kind === 'info'
              ? 'info'
              : 'neutral'
      const title = String(payload.title ?? '').trim()
      const detail = String(payload.detail ?? '').trim()
      showToast({
        title: title || message,
        // 有标题时 message 是说明、detail 是原始错误（RPC/连接错误原文）。
        // 旧实现有标题就丢掉 detail——插件侧"无法打开 … 的聊天"这类 toast
        // 只剩"请重试"，用户看不到真正原因（2026-11-27 实报）。
        description: title ? (
          <>
            {message}
            {detail ? (
              <>
                <br />
                <span className="break-words opacity-70">{detail}</span>
              </>
            ) : null}
          </>
        ) : (
          (detail || undefined)
        ),
        status,
        // persistent = 不自动消失（hermes notify 的 persistent 语义）。
        ...(payload.persistent ? { duration: 0 } : {}),
      })
    }
    window.addEventListener('mirach:toast', onToast)
    return () => window.removeEventListener('mirach:toast', onToast)
  }, [showToast])

  // fixed = portal 到 body 的浮层（用户 2026-11-27："错误卡出现在上方把内容
  // 挤下面"）——旧实现 static 叠在 app 根文档流里，toast 一出现就把整个壳
  // 往下推。位置 = 右下角，不挡主区内容。
  return <AnimatedToastStack fixed toasts={stack.toasts} onDismiss={stack.dismissToast} />
}
