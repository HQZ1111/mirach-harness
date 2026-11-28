/**
 * 文件预览页签（v8.0 dockview 版）：内容从 params.filePath 现读 fs_read_data_url（≤16MB）。
 * 图片直显；html 沙箱 iframe 渲染成网页；代码/文本文件按扩展名分流——
 * 在语言映射表内走 CodePreview（Shiki 高亮 + 行号，超预算诚实降级纯文本），
 * 未知扩展名纯文本 pre（不猜语言）；二进制提示；读失败错误可见。
 */
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CodePreview } from '@/components/preview/code-preview'
import { shikiLanguageForFilename } from '@/components/preview/code-language'
import { WebPreview } from '@/components/assistant-ui/elements/web-preview'
import { inTauri } from '@/lib/tauri-window'
import { fsReadDataUrl } from '@/lib/fs'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'])
const HTML_EXTS = new Set(['html', 'htm'])

/**
 * 把 `data:<mime>;base64,<payload>` 解成 UTF-8 文本（不经 fetch）。
 *
 * 非 base64 的 data URL（`data:text/plain,hello`）直接取逗号后原文的
 * percent-decode 结果，保证两种形态都能读。
 */
function decodeDataUrlText(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  if (comma < 0) throw new Error('不是合法的 data URL')
  const meta = dataUrl.slice(0, comma)
  const payload = dataUrl.slice(comma + 1)
  if (!/;base64$/i.test(meta)) {
    return decodeURIComponent(payload)
  }
  const binary = atob(payload)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder('utf-8').decode(bytes)
}

export function HermesPreviewPane({ filePath }: { filePath: string }) {
  const name = filePath.split('/').pop() ?? filePath
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const language = shikiLanguageForFilename(filePath)
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'text'; text: string } | { kind: 'image'; url: string } | { kind: 'html'; html: string } | { kind: 'binary' } | { kind: 'error'; message: string }
  >({ kind: 'loading' })
  /** 刷新计数（WebPreview 的刷新钮 → 重读文件；不换文件重挂 iframe）。 */
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let dead = false
    setState({ kind: 'loading' })
    if (!filePath) return
    void (async () => {
      try {
        const dataUrl = await fsReadDataUrl(filePath)
        if (dead) return
        if (IMAGE_EXTS.has(ext)) {
          setState({ kind: 'image', url: dataUrl })
        } else {
          // 文本一律从 data URL **本地解码**，不走 `fetch(dataUrl)`。
          // 2026-11-27 用户实报「点文件后面板显示文件读取失败：Failed to fetch」：
          // WebView2 对 data: URL 的 fetch 在部分长度/编码下直接 reject
          // （CSP 与 URL 解析都可能参与），而这里的数据本来就已经在手上了，
          // 再绕一圈网络栈只会多一个失败点。
          const text = decodeDataUrlText(dataUrl)
          if (dead) return
          if (HTML_EXTS.has(ext)) {
            setState({ kind: 'html', html: text })
          } else if (text.includes('\u0000')) {
            setState({ kind: 'binary' })
          } else {
            setState({ kind: 'text', text })
          }
        }
      } catch (error) {
        // 禁止兜底：读失败 ≠ 二进制，错误原文可见（此前误标成"二进制文件"）。
        const message = error instanceof Error ? error.message : String(error)
        console.error('文件预览读取失败', filePath, error)
        if (!dead) setState({ kind: 'error', message })
      }
    })()
    return () => {
      dead = true
    }
  }, [filePath, ext, reloadKey])

  /** html 预览的外开（宿主不装 opener 插件，走 fs_open_url；浏览器直开退 window.open）。 */
  const openExternal = useCallback(() => {
    if (!inTauri) {
      window.open(filePath, '_blank', 'noopener,noreferrer')
      return
    }
    void invoke('fs_open_url', { url: filePath }).catch((e) => {
      // 规矩 11：打开失败可见
      console.error('[preview] 外开失败', filePath, e)
    })
  }, [filePath])

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--surface)">
      <div className="flex items-center gap-2 border-b border-(--stroke-soft) px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-(--text-2)" title={filePath}>
          {filePath}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {/* html 预览：外壳用官方 elements/web-preview（跟 aui 上游走）——
            刷新钮 = 重读文件（reloadKey），地址条显示文件路径，外开走
            fs_open_url。加载/读错时外壳保持在场（loading 遮罩/错误面）。
            挂载/形态抄 hermes 右栏 preview-pane 的"chrome 包沙箱 frame"。 */}
        {HTML_EXTS.has(ext) ? (
          <WebPreview
            className="h-full max-w-none rounded-none shadow-none"
            loading={state.kind === 'loading'}
            origin={filePath}
            onOpenExternal={openExternal}
            onReload={() => setReloadKey((k) => k + 1)}
          >
            {state.kind === 'html' && (
              <iframe
                // 沙箱文档用自己的默认底色（白）——显式给白底是刻意的：
                // 无样式的用户 HTML 在深色主题下若不铺白底会变成黑底黑字。
                className="h-full min-h-0 w-full border-0 bg-white"
                sandbox=""
                srcDoc={state.html}
                title={name}
              />
            )}
            {state.kind === 'error' && (
              <div className="p-3 text-xs text-destructive">文件读取失败：{state.message}</div>
            )}
          </WebPreview>
        ) : (
          <>
            {state.kind === 'loading' && <div className="p-3 text-xs text-(--text-4)">加载中…</div>}
            {state.kind === 'image' && <img alt={name} className="max-w-full" src={state.url} />}
          </>
        )}
        {state.kind === 'text' && language !== '' && <CodePreview language={language} text={state.text} />}
        {state.kind === 'text' && language === '' && (
          <pre className="p-3 font-mono text-[0.75rem] leading-5 whitespace-pre-wrap break-all text-(--text-2)">
            {state.text}
          </pre>
        )}
        {/* html 的读错在 WebPreview 外壳内渲染（上面分支），这里只兜非 html */}
        {!HTML_EXTS.has(ext) && state.kind === 'error' && (
          <div className="p-3 text-xs text-destructive">文件读取失败：{state.message}</div>
        )}
        {state.kind === 'binary' && (
          <div className="p-3 text-xs text-(--text-4)">二进制文件，不支持预览</div>
        )}
      </div>
    </div>
  )
}

/** 复用给文件树的类型徽章（与文件树同表）。 */
export { } 
