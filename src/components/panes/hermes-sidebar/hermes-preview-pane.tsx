/**
 * 文件预览页签（右侧栏标签，不占文件树）：flexlayout factory 特例渲染，
 * 内容从节点 config.filePath 现读 fs_read_data_url（≤16MB）。
 * 图片直显；html 沙箱 iframe 渲染成网页；文本 pre；二进制提示。
 */
import { useEffect, useState } from 'react'
import type { TabNode } from 'flexlayout-react'

import { fsReadDataUrl } from '@/lib/fs'
import { cn } from '@/lib/utils'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp'])
const HTML_EXTS = new Set(['html', 'htm'])

export function HermesPreviewPane({ node }: { node: TabNode }) {
  const cfg = node.getConfig() as { filePath?: string } | undefined
  const filePath = cfg?.filePath ?? ''
  const name = filePath.split('/').pop() ?? filePath
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'text'; text: string } | { kind: 'image'; url: string } | { kind: 'html'; html: string } | { kind: 'binary' }
  >({ kind: 'loading' })

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
        } else if (HTML_EXTS.has(ext)) {
          const res = await fetch(dataUrl)
          setState({ kind: 'html', html: await res.text() })
        } else {
          const res = await fetch(dataUrl)
          const text = await res.text()
          if (dead) return
          if (text.includes('\u0000')) setState({ kind: 'binary' })
          else setState({ kind: 'text', text })
        }
      } catch {
        if (!dead) setState({ kind: 'binary' })
      }
    })()
    return () => {
      dead = true
    }
  }, [filePath, ext])

  return (
    <div className="flex h-full min-h-0 flex-col bg-(--surface)">
      <div className="flex items-center gap-2 border-b border-(--stroke-soft) px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate text-xs text-(--text-2)" title={filePath}>
          {filePath}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {state.kind === 'loading' && <div className="p-3 text-xs text-(--text-4)">加载中…</div>}
        {state.kind === 'image' && <img alt={name} className="max-w-full" src={state.url} />}
        {state.kind === 'html' && (
          <iframe
            className="h-full min-h-0 w-full border-0 bg-white"
            sandbox=""
            srcDoc={state.html}
            title={name}
          />
        )}
        {state.kind === 'text' && (
          <div className="min-h-0 flex-1 overflow-auto font-mono text-[0.75rem] leading-5">
            <div className="min-w-max py-2">
              {state.text.split('\n').map((line, i) => (
                <div className="flex" key={i}>
                  <span className="sticky left-0 w-10 shrink-0 select-none bg-(--surface) pr-2 text-right text-(--text-4)">
                    {i + 1}
                  </span>
                  <span className="whitespace-pre pr-6 text-(--text-2)">{line === '' ? ' ' : line}</span>
                </div>
              ))}
            </div>
          </div>
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
