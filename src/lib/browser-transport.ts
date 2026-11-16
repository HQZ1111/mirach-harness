/**
 * 浏览器传输层（hermes `lib/browser-transport.ts` 的宿主对偶）。
 *
 * ## 宿主事实
 *
 * 上游用它在**内嵌浏览器面板**里把 guest webview 的文档与 RPC 端点接出来
 * （`preview-document-frame.tsx` 依赖 `browserBootstrap` / `endpointUrl`）。
 *
 * **Mirach 没有内嵌浏览器面板**（预览走 `HermesPreviewPane` 的文件预览，
 * 不是 webview）。所以这里的每个导出都返回「不可用」，让调用方走自己的
 * 降级分支——而不是伪造一个能跑的浏览器。
 *
 * `isBrowserHostedDesktop()` 是关键判据：返回 false 时上游的
 * `preview-document-frame` 不会尝试挂 iframe。
 */

/** 是否运行在「浏览器托管」的桌面壳里（宿主：不是）。 */
export function isBrowserHostedDesktop(): boolean {
  return false
}

/** 是否可用（宿主：否）。 */
export function isBrowserTransportAvailable(): boolean {
  return false
}

/**
 * 浏览器 bootstrap 脚本（上游返回注入 guest 文档的 JS 字符串）。
 *
 * 宿主无 guest 文档 → 返回空串。调用方拼进 srcdoc 时就是空，不执行任何东西。
 */
export function browserBootstrap(): string {
  return ''
}

/** 传输端点 URL（宿主无端点）。 */
export function endpointUrl(_kind?: string): null {
  return null
}

/** 传输实例（宿主无实例）。 */
export function browserTransport(): null {
  return null
}

/**
 * data URL → HTML 文本（上游 `htmlFromDataUrl`）。
 *
 * 这个是**纯工具**，宿主可以真实现：解析 `data:text/html;base64,xxx`。
 * 上游用在「预览 data URL 形式的 HTML 文档」。
 */
export function htmlFromDataUrl(dataUrl: string): null | string {
  const match = /^data:text\/html(?:;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(dataUrl)
  if (!match) return null
  const [, base64, body] = match
  try {
    if (base64) {
      // atob 在浏览器里可用；Node 侧退 Buffer
      if (typeof atob === 'function') {
        const binary = atob(body ?? '')
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0))
        return new TextDecoder().decode(bytes)
      }
      return Buffer.from(body ?? '', 'base64').toString('utf8')
    }
    return decodeURIComponent(body ?? '')
  } catch {
    return null
  }
}

/**
 * 连接目标状态（上游 `ConnectionTargetState` 类型 + 运行时判据）。
 *
 * 宿主只有本地连接，恒 'local'。
 */
export type ConnectionTargetState = 'local' | 'remote' | 'unknown'

export function connectionTargetState(_connectionId?: null | string): ConnectionTargetState {
  return 'local'
}