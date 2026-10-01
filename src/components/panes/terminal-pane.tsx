/**
 * 终端窗格（真终端）——多页签（每页签一个 PTY 会话，「+」新开）+ xterm.js。
 * 结构照抄 ZCode packages/ui/src/terminal/TerminalSession.tsx：
 *   - xterm + FitAddon + ClipboardAddon（OSC 52/选区复制）；先 fit 后 spawn
 *     （启动输出不按默认尺寸重排，ZCode 同款时序）
 *   - PTY 输出（Tauri Event，通道裁定见 src-tauri/src/terminal.rs 模块头）
 *     → base64 解码 → 流式 UTF-8 还原 → PSReadLine 重绘归一 → term.write
 *   - 输入 = term.onData → terminal_write；Ctrl/Cmd+C（有选区）/V 走剪贴板
 *   - resize = ResizeObserver → rAF fit → 尺寸去重 + 在途守卫 → terminal_resize
 *     （ptyId 未就绪先排队，spawn 后 flush）
 *   - 链接 = OSC 8 linkHandler + buffer 行扫描 provider → terminal_open_url
 *
 * 【生命周期】窗格卸载（flexlayout 切页签/关窗格）= kill 该窗格全部会话
 * （清理路径定稿）；应用退出由 Rust TerminalRegistry::drop 兜底。
 * StrictMode 双挂载：cancelled 守卫——卸载时未就绪的 spawn 被识别为孤儿
 * PTY 立即回收，不留僵尸进程。
 */

import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import type { ILink } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useCallback, useEffect, useRef, useState } from 'react'

import { CloseIcon } from '@/components/ui/codicons'
import { inTauri } from '@/lib/tauri-window'
import { PlaceholderPane } from './placeholder-pane'
import { base64ToBytes, formatShellLabel } from './terminal/terminal-format'
import { normalizePowerShellReadlineRedraw } from './terminal/terminal-data-transform'
import { getHttpLinksForTerminalBufferLine } from './terminal/terminal-links'
import {
  getTerminalFont,
  getTerminalTheme,
} from './terminal/terminal-theme'
import {
  killTerminal,
  onTerminalExit,
  onTerminalOutput,
  openTerminalUrl,
  resizeTerminal,
  spawnTerminal,
  writeTerminal,
  type UnlistenFn,
} from './terminal/terminal-pty'

/** ConPTY 在增高时不会像 Unix PTY 拉回 scrollback——开启 xterm 的
 *  windowsPty 兼容，否则 PSReadLine 重绘会覆盖上一条命令输出行（ZCode 同款） */
const IS_WINDOWS = navigator.userAgent.includes('Windows')

interface TerminalSize {
  cols: number
  rows: number
}

type TabStatus = 'starting' | 'ready' | 'exited' | 'error'

interface TerminalTab {
  key: string
  label: string
  status: TabStatus
  exitCode: number | null
  error: string | null
}

/** 单页签的运行时对象（xterm + PTY 订阅）——React 状态之外，Map 持有 */
interface TerminalSessionRT {
  key: string
  hostEl: HTMLDivElement
  term: XTerm
  fitAddon: FitAddon
  /** 流式 UTF-8 解码器：PTY 一次 read 可能劈开多字节序列 */
  decoder: TextDecoder
  shell: string | null
  ptyId: number | null
  exited: boolean
  /** StrictMode 卸载/页签关闭竞态：spawn 未就绪的会话被标记后回收孤儿 PTY */
  cancelled: boolean
  unlisten: UnlistenFn[]
  pendingSize: TerminalSize | null
  lastSentSize: TerminalSize | null
  resizeInFlight: boolean
}

export function TerminalPane(_props: { tabName?: string }) {
  // 容器：活动页签的 hostEl 挂在这里（命令式管理，React 不掺和它的子节点）
  const containerRef = useRef<HTMLDivElement>(null)
  const sessionsRef = useRef(new Map<string, TerminalSessionRT>())
  const seqRef = useRef(0)

  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const activeKeyRef = useRef<string | null>(null)

  // ── resize 管线（ZCode 的去重 + 在途守卫简化版） ─────────────────────────

  const flushResize = useCallback((rt: TerminalSessionRT) => {
    if (rt.resizeInFlight) return
    const pending = rt.pendingSize
    if (rt.ptyId == null || !pending) return
    rt.pendingSize = null
    rt.resizeInFlight = true
    resizeTerminal(rt.ptyId, pending.cols, pending.rows)
      .catch((err) => console.error('[terminal] resize failed:', err))
      .finally(() => {
        rt.resizeInFlight = false
        if (rt.pendingSize) flushResize(rt)
      })
  }, [])

  const fitAndQueueResize = useCallback(
    (rt: TerminalSessionRT) => {
      const container = containerRef.current
      if (!container || container.clientWidth <= 0 || container.clientHeight <= 0) return
      try {
        rt.fitAddon.fit()
      } catch (err) {
        console.error('[terminal] fit failed:', err)
        return
      }
      const size = { cols: rt.term.cols, rows: rt.term.rows }
      const last = rt.lastSentSize
      const pending = rt.pendingSize
      if (
        (last && last.cols === size.cols && last.rows === size.rows && !pending) ||
        (pending && pending.cols === size.cols && pending.rows === size.rows)
      ) {
        return
      }
      rt.pendingSize = size
      rt.lastSentSize = size
      flushResize(rt)
    },
    [flushResize],
  )

  // ── 会话生命周期 ─────────────────────────────────────────────────────────

  const disposeSession = useCallback((key: string) => {
    const rt = sessionsRef.current.get(key)
    if (!rt) return
    rt.cancelled = true
    for (const un of rt.unlisten) un()
    rt.unlisten = []
    if (rt.ptyId != null) {
      // 关闭 = kill（退出码事件随后到达，页签已不在，事件被丢弃）
      killTerminal(rt.ptyId).catch((err) => console.error('[terminal] kill on close failed:', err))
    }
    try {
      rt.term.dispose()
    } catch (err) {
      console.error('[terminal] term dispose failed:', err)
    }
    rt.hostEl.remove()
    sessionsRef.current.delete(key)
  }, [])

  const disposeAllSessions = useCallback(() => {
    for (const key of [...sessionsRef.current.keys()]) disposeSession(key)
  }, [disposeSession])

  const createSession = useCallback(
    (key: string) => {
      const container = containerRef.current
      if (!container) return

      const hostEl = document.createElement('div')
      hostEl.className = 'term-host'
      container.replaceChildren(hostEl)

      const font = getTerminalFont()
      const term = new XTerm({
        fontSize: font.fontSize,
        fontFamily: font.fontFamily,
        theme: getTerminalTheme(),
        scrollback: 5000,
        linkHandler: {
          allowNonHttpProtocols: false,
          activate(event, text) {
            if (!/^https?:\/\//i.test(text)) return
            event.preventDefault()
            openTerminalUrl(text).catch((err) =>
              console.error('[terminal] open url failed:', err),
            )
          },
        },
      })
      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.loadAddon(new ClipboardAddon())
      term.open(hostEl)

      const rt: TerminalSessionRT = {
        key,
        hostEl,
        term,
        fitAddon,
        decoder: new TextDecoder('utf-8'),
        shell: null,
        ptyId: null,
        exited: false,
        cancelled: false,
        unlisten: [],
        pendingSize: null,
        lastSentSize: null,
        resizeInFlight: false,
      }
      sessionsRef.current.set(key, rt)

      // Ctrl/Cmd+C 有选区走复制（否则 SIGINT）、Ctrl/Cmd+V 走粘贴（否则当
      // ^V 输入）。返回 false 只拦 xterm 的处理，原生 paste 仍会派发——
      // 必须先取消默认再手动单次写入，否则双写（ZCode 同款注释）
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true
        if (!(e.ctrlKey || e.metaKey)) return true
        const k = e.key.toLowerCase()
        if (k === 'c' && term.hasSelection()) {
          void navigator.clipboard
            .writeText(term.getSelection())
            .catch((err) => console.error('[terminal] copy failed:', err))
          return false
        }
        if (k === 'v') {
          e.preventDefault()
          e.stopPropagation()
          navigator.clipboard
            .readText()
            .then((text) => {
              if (text) term.paste(text)
            })
            .catch((err) => console.error('[terminal] paste failed:', err))
          return false
        }
        return true
      })

      // 纯文本 http 链接（buffer 行扫描、折行合并，ZCode 同款）
      term.registerLinkProvider({
        provideLinks(bufferLineNumber, callback) {
          const links = getHttpLinksForTerminalBufferLine(
            term.buffer.active,
            bufferLineNumber,
            term.cols,
          )?.map((link): ILink => ({
            ...link,
            activate(event, text) {
              event.preventDefault()
              openTerminalUrl(text).catch((err) =>
                console.error('[terminal] open url failed:', err),
              )
            },
          }))
          callback(links)
        },
      })

      // 输入 → PTY。已退出/已取消/PTY 未就绪的会话不写——进程已消失，
      // 写入必 Err，跳过是生命周期语义不是兜底
      term.onData((data) => {
        if (rt.cancelled || rt.exited || rt.ptyId == null) return
        writeTerminal(rt.ptyId, data).catch((err) =>
          console.error('[terminal] write failed:', err),
        )
      })

      // 先 fit 用真实 cols/rows 启动 PTY；此后排队的 resize 由 id 就绪 flush
      fitAndQueueResize(rt)
      const initial = rt.lastSentSize ?? { cols: term.cols, rows: term.rows }

      void (async () => {
        try {
          const spawned = await spawnTerminal(initial.cols, initial.rows)
          if (rt.cancelled) {
            // 卸载竞态：孤儿 PTY 立即回收，不进会话
            killTerminal(spawned.id).catch((err) =>
              console.error('[terminal] orphan kill failed:', err),
            )
            return
          }
          rt.ptyId = spawned.id
          rt.shell = spawned.shell
          if (IS_WINDOWS) term.options.windowsPty = { backend: 'conpty' }
          setTabs((ts) =>
            ts.map((t) =>
              t.key === key
                ? { ...t, label: formatShellLabel(spawned.shell) ?? t.label, status: 'ready' }
                : t,
            ),
          )

          // 事件订阅（Tauri Event——通道裁定见 terminal-pty.ts 头注释）。
          // 每次订阅落位后复查 cancelled：dispose 可能抢在 await 之间完成
          // （已 drain 过 rt.unlisten，晚到的订阅必须自己拆掉防泄漏）
          const outUn = await onTerminalOutput(spawned.id, (ev) => {
            const text = rt.decoder.decode(base64ToBytes(ev.data), { stream: true })
            if (text) term.write(normalizePowerShellReadlineRedraw(text, rt.shell))
          })
          if (rt.cancelled) {
            outUn()
            return
          }
          rt.unlisten.push(outUn)

          const exitUn = await onTerminalExit(spawned.id, (ev) => {
            rt.exited = true
            const line = ev.error
              ? `\r\n\x1b[31m${ev.error}\x1b[0m\r\n`
              : `\r\n\x1b[2m进程已退出 (code ${ev.exitCode})\x1b[0m\r\n`
            term.write(line)
            setTabs((ts) =>
              ts.map((t) =>
                t.key === key
                  ? { ...t, status: 'exited', exitCode: ev.exitCode, error: ev.error }
                  : t,
              ),
            )
          })
          if (rt.cancelled) {
            exitUn()
            return
          }
          rt.unlisten.push(exitUn)

          // id 就绪：flush 创建期间排队的 resize（否则相同尺寸被去重跳过）
          flushResize(rt)
          term.focus()
        } catch (err) {
          if (rt.cancelled) return
          console.error('[terminal] spawn failed:', err)
          const message = err instanceof Error ? err.message : String(err)
          setTabs((ts) =>
            ts.map((t) => (t.key === key ? { ...t, status: 'error', error: message } : t)),
          )
        }
      })()
    },
    [fitAndQueueResize, flushResize],
  )

  // ── 页签操作 ─────────────────────────────────────────────────────────────

  const addTab = useCallback(() => {
    seqRef.current += 1
    const key = `t${seqRef.current}`
    setTabs((ts) => [
      ...ts,
      { key, label: '终端', status: 'starting', exitCode: null, error: null },
    ])
    activeKeyRef.current = key
    setActiveKey(key)
    createSession(key)
  }, [createSession])

  const switchTab = useCallback((key: string) => {
    if (activeKeyRef.current === key) return
    activeKeyRef.current = key
    setActiveKey(key)
  }, [])

  const closeTab = useCallback(
    (key: string) => {
      disposeSession(key)
      const ts = tabsRef.current
      const idx = ts.findIndex((t) => t.key === key)
      const next = ts.filter((t) => t.key !== key)
      setTabs(next)
      if (activeKeyRef.current === key) {
        // 关活动页签 → 激活邻居（右邻优先、左邻兜底、空则无）
        const neighbor = next[Math.min(Math.max(idx, 0), next.length - 1)]?.key ?? null
        activeKeyRef.current = neighbor
        setActiveKey(neighbor)
      }
    },
    [disposeSession],
  )

  const restartSession = useCallback(
    (key: string) => {
      disposeSession(key)
      setTabs((ts) =>
        ts.map((t) =>
          t.key === key
            ? { ...t, label: '终端', status: 'starting', exitCode: null, error: null }
            : t,
        ),
      )
      createSession(key)
    },
    [createSession, disposeSession],
  )

  // ── effects ──────────────────────────────────────────────────────────────

  // 挂载：建第一个页签。卸载（关窗格/切 flexlayout 页签/StrictMode 重跑）=
  // kill 该窗格全部会话（清理路径定稿）；应用退出由 Rust Drop 兜底。
  useEffect(() => {
    if (!inTauri) return
    addTab()
    return () => {
      disposeAllSessions()
      setTabs([])
      activeKeyRef.current = null
      setActiveKey(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 活动页签切换：DOM 归位 + fit（页签间尺寸不同）+ flush + 聚焦
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    if (!activeKey) {
      container.replaceChildren()
      return
    }
    const rt = sessionsRef.current.get(activeKey)
    if (!rt) return
    container.replaceChildren(rt.hostEl)
    const raf = requestAnimationFrame(() => {
      fitAndQueueResize(rt)
      rt.term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [activeKey, fitAndQueueResize])

  // 容器尺寸变化（分隔条拖拽/整栏 resize）→ fit 活动会话 → 排队后端 resize
  useEffect(() => {
    const container = containerRef.current
    if (!container || !inTauri) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        const rt = activeKeyRef.current
          ? sessionsRef.current.get(activeKeyRef.current)
          : undefined
        if (rt) fitAndQueueResize(rt)
      })
    })
    ro.observe(container)
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [fitAndQueueResize])

  // ── 渲染 ─────────────────────────────────────────────────────────────────

  if (!inTauri) {
    // 能力声明不是兜底：PTY 由 Tauri 壳提供，纯浏览器 dev 没有这条路
    return (
      <PlaceholderPane
        title="终端"
        description="终端需要 Tauri 壳提供 PTY——纯浏览器 dev 无此能力。"
        hints={['在应用窗口内使用终端窗格。']}
      />
    )
  }

  const activeTab = tabs.find((t) => t.key === activeKey) ?? null
  const showExitBar =
    activeTab && (activeTab.status === 'exited' || activeTab.status === 'error')

  return (
    <div className="term-pane">
      <div className="term-strip" role="tablist" aria-label="终端页签">
        {tabs.map((t) => (
          <div
            key={t.key}
            className={`term-tab${t.key === activeKey ? ' active' : ''}`}
            role="tab"
            aria-selected={t.key === activeKey}
          >
            <button
              type="button"
              className="term-tab-label"
              title={t.status === 'exited' ? `进程已退出 (code ${t.exitCode})` : t.label}
              onClick={() => switchTab(t.key)}
            >
              {t.label}
              {t.status === 'starting' ? '…' : ''}
            </button>
            <button
              type="button"
              className="term-tab-close"
              aria-label={`关闭 ${t.label}`}
              onClick={() => closeTab(t.key)}
            >
              <CloseIcon size={10} />
            </button>
          </div>
        ))}
        <button type="button" className="term-add" aria-label="新建终端" onClick={() => addTab()}>
          +
        </button>
      </div>
      <div className="term-body">
        <div ref={containerRef} className="term-host-container" />
        {tabs.length === 0 && <div className="term-empty">无终端页签——点「+」新建。</div>}
      </div>
      {showExitBar && activeTab && (
        <div className="term-exit-bar">
          <span>
            {activeTab.status === 'error'
              ? `终端启动失败：${activeTab.error ?? '未知错误'}`
              : (activeTab.error ?? `进程已退出 (code ${activeTab.exitCode})`)}
          </span>
          <button type="button" className="term-exit-reopen" onClick={() => restartSession(activeTab.key)}>
            重新打开
          </button>
        </div>
      )}
    </div>
  )
}
