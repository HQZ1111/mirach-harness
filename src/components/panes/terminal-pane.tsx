/**
 * 终端窗格（真终端）——多页签（每页签一个 PTY 会话，「+」新开）+ xterm.js。
 * 结构照抄 ZCode packages/ui/src/terminal/TerminalSession.tsx（2026-11-15
 * 对齐第二轮）：
 *   - xterm + FitAddon + ClipboardAddon（OSC 52/选区复制）；先 fit 后 spawn
 *     （启动输出不按默认尺寸重排，ZCode 同款时序）
 *   - PTY 输出（Tauri Event，通道裁定见 src-tauri/src/terminal.rs 模块头）
 *     → base64 解码 → **attach gate**（backlog 先回放、事件后放行，顺序不
 *     依赖 IPC 到达顺序）→ 流式 UTF-8 还原 → PSReadLine 重绘归一 → term.write
 *   - 输入 = term.onData → terminal_write；Windows 输入法 composed text 兜底
 *     （terminal-composed-input.ts，ZCode 同源）；Ctrl/Cmd+C（有选区）/V 走剪贴板
 *   - resize = ResizeObserver → rAF fit → 尺寸去重 + 在途守卫 → terminal_resize
 *     （ptyId 未就绪先排队，attach 后 flush）；面板重新可见时补一次 fit+focus
 *   - 链接 = OSC 8 linkHandler + buffer 行扫描 provider → terminal_open_url
 *   - 页签名 = 项目名（cwd 末段）+ 序号（ZCode formatTerminalTabTitle）
 *
 * 【首屏输出】spawn 返回后才有 id，订阅事件之前 shell 已经可能写过 banner
 * ——宿主把这些字节存进 backlog，`terminal_attach` 一次性回放；未订阅就
 * 退出的会话同样靠 attach 的 exit 补发（否则页签永远停在"运行中"）。
 *
 * 【生命周期】窗格卸载（关窗格/布局重建）= kill 该窗格全部会话（清理路径
 * 定稿）；应用退出由 Rust TerminalRegistry::drop 兜底。StrictMode 双挂载：
 * cancelled 守卫——卸载时未就绪的 spawn 被识别为孤儿 PTY 立即回收。
 */

import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import type { ILink } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { DockviewPanelApi } from 'dockview-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { sessionCatalog } from '@/components/panes/session-manage/session-catalog'
import { CloseIcon } from '@/components/ui/codicons'
import { inTauri } from '@/lib/tauri-window'
import { PlaceholderPane } from './placeholder-pane'
import {
  consumeTerminalInputFallbackHandledData,
  createPendingTerminalInputFallback,
  createTerminalInputFallbackKeydownCandidate,
  markTerminalInputFallbackHandled,
  recordTerminalInputFallbackHandledData,
  recordTerminalInputFallbackRecentData,
  resolveTerminalInputFallbackAction,
  type PendingTerminalInputFallback,
  type TerminalInputFallbackHandledData,
  type TerminalInputFallbackKeydownCandidate,
} from './terminal/terminal-composed-input'
import { pickTerminalCwd } from './terminal/terminal-cwd'
import { base64ToBytes, formatShellLabel } from './terminal/terminal-format'
import { normalizePowerShellReadlineRedraw } from './terminal/terminal-data-transform'
import { getHttpLinksForTerminalBufferLine } from './terminal/terminal-links'
import { TerminalOutputGate } from './terminal/terminal-output-gate'
import {
  formatTerminalTabTitle,
  nextTerminalIndex,
  terminalProjectName,
} from './terminal/terminal-tabs'
import {
  getTerminalFont,
  getTerminalTheme,
} from './terminal/terminal-theme'
import {
  attachTerminal,
  killTerminal,
  onTerminalExit,
  onTerminalOutput,
  openTerminalUrl,
  resizeTerminal,
  spawnTerminal,
  writeTerminal,
  type TerminalExit,
  type UnlistenFn,
} from './terminal/terminal-pty'

/** ConPTY 在增高时不会像 Unix PTY 拉回 scrollback——开启 xterm 的
 *  windowsPty 兼容，否则 PSReadLine 重绘会覆盖上一条命令输出行（ZCode 同款） */
const IS_WINDOWS = navigator.userAgent.includes('Windows')

/** 输入法 composed text 兜底的时间窗（ZCode TerminalSession 同值） */
const INPUT_FALLBACK_RECENT_DATA_MS = 150
const INPUT_FALLBACK_KEYDOWN_INPUT_MS = 40
const INPUT_FALLBACK_FLUSH_DELAY_MS = 150

interface TerminalSize {
  cols: number
  rows: number
}

type TabStatus = 'starting' | 'ready' | 'exited' | 'error'

interface TerminalTab {
  key: string
  /** 页签序号（同工作区内的第几个；关掉 2 号后新建仍是 2，见 terminal-tabs） */
  index: number
  /** 项目名 = 该页签 cwd 的末段；null = 未知（显示「终端」） */
  projectName: string | null
  cwd: string | null
  shellLabel: string | null
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
  /** 输出装配闸门：attach 前排队、attach 后放行（顺序 + 流式 UTF-8） */
  gate: TerminalOutputGate
  shell: string | null
  ptyId: number | null
  /** attach 已回放——退出事件在此之前到达要先存着，等回放完再落 UI */
  attached: boolean
  exited: boolean
  pendingExit: TerminalExit | null
  /** StrictMode 卸载/页签关闭竞态：spawn 未就绪的会话被标记后回收孤儿 PTY */
  cancelled: boolean
  unlisten: UnlistenFn[]
  detachTextareaInput: (() => void) | null
  pendingSize: TerminalSize | null
  lastSentSize: TerminalSize | null
  resizeInFlight: boolean
  /** xterm.open 已执行（隐藏面板延迟到可见时，见 ensureSpawned） */
  opened: boolean
  /** PTY 已启动（延迟启动的幂等闸门，见 createSession 的 ensureSpawned） */
  spawnStarted: boolean
  /** 有效尺寸就绪后 fit+spawn；面板隐藏/零尺寸时由布局回调重试 */
  ensureSpawned: (() => void) | null
  // ── Windows 输入法 composed text 兜底（ZCode 同源状态） ──
  inputFallbacks: PendingTerminalInputFallback[]
  keydownCandidate: TerminalInputFallbackKeydownCandidate | null
  recentHandled: TerminalInputFallbackHandledData[]
}

export function TerminalPane({ api }: { api?: DockviewPanelApi }) {
  // 容器：活动页签的 hostEl 挂在这里（命令式管理，React 不掺和它的子节点）
  const containerRef = useRef<HTMLDivElement>(null)
  const sessionsRef = useRef(new Map<string, TerminalSessionRT>())
  const seqRef = useRef(0)

  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const activeKeyRef = useRef<string | null>(null)

  const setTabState = useCallback(
    (key: string, patch: Partial<TerminalTab>) => {
      setTabs((ts) => ts.map((t) => (t.key === key ? { ...t, ...patch } : t)))
    },
    [],
  )

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
    rt.detachTextareaInput?.()
    rt.detachTextareaInput = null
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
    (key: string, cwd: string | undefined) => {
      const container = containerRef.current
      if (!container) {
        // 容器缺席 = 布局竞态。禁止留一个永远 "starting" 的页签（规矩 12：
        // 失败必须可见），页签转 error，退出条会显示原因并给"重新打开"。
        console.error('[terminal] 容器不在场——会话未创建')
        setTabState(key, { status: 'error', error: '终端容器不在场（布局未就绪）' })
        return
      }

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
      // term.open 延迟到面板真正可见（ensureSpawned）——隐藏/零尺寸时
      // open 会让 xterm 的滚动同步 rAF 与 dispose 竞态（实测 boot 期
      // "Cannot read properties of undefined (reading 'dimensions')"）。

      const rt: TerminalSessionRT = {
        key,
        hostEl,
        term,
        fitAddon,
        gate: new TerminalOutputGate(),
        shell: null,
        ptyId: null,
        attached: false,
        exited: false,
        pendingExit: null,
        cancelled: false,
        unlisten: [],
        detachTextareaInput: null,
        pendingSize: null,
        lastSentSize: null,
        resizeInFlight: false,
        opened: false,
        spawnStarted: false,
        ensureSpawned: null,
        inputFallbacks: [],
        keydownCandidate: null,
        recentHandled: [],
      }
      sessionsRef.current.set(key, rt)

      /** 输出落屏（PSReadLine 重绘归一需要 shell 名） */
      const writeOutput = (text: string) => {
        if (!text) return
        rt.term.write(normalizePowerShellReadlineRedraw(text, rt.shell))
      }

      /** PTY 写入（会话已取消/已退出/PTY 未就绪不写——生命周期语义，不是兜底） */
      const writeInput = (data: string) => {
        if (rt.cancelled || rt.exited || rt.ptyId == null) return
        writeTerminal(rt.ptyId, data).catch((err) =>
          console.error('[terminal] write failed:', err),
        )
      }

      /** 退出落地：写提示 + 页签转 exited（事件与 attach 回放可能各来一次） */
      const applyExit = (exit: TerminalExit) => {
        if (rt.exited || rt.cancelled) return
        rt.exited = true
        // 冲掉解码器里悬挂的多字节尾巴（最后一块可能劈开一个汉字）
        writeOutput(rt.gate.finish())
        const line = exit.error
          ? `\r\n\x1b[31m${exit.error}\x1b[0m\r\n`
          : `\r\n\x1b[2m进程已退出 (code ${exit.exitCode})\x1b[0m\r\n`
        rt.term.write(line)
        setTabState(key, {
          status: 'exited',
          exitCode: exit.exitCode,
          error: exit.error,
        })
      }

      // Ctrl/Cmd+C 有选区走复制（否则 SIGINT）、Ctrl/Cmd+V 走粘贴（否则当
      // ^V 输入）。返回 false 只拦 xterm 的处理，原生 paste 仍会派发——
      // 必须先取消默认再手动单次写入，否则双写（ZCode 同款注释）。
      // keydown 先记候选：Windows 输入法 composed text 兜底靠它去重。
      term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true
        rt.keydownCandidate =
          e.metaKey || e.ctrlKey || e.altKey
            ? null
            : createTerminalInputFallbackKeydownCandidate({
                eventTimeStamp: e.timeStamp,
                key: e.key,
                now: performance.now(),
              })
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

      // 输入 → PTY。先维护输入法兜底的去重账本（ZCode 同源）：
      // onData 认领过同一段 keydown/近期数据，textarea 兜底就不再写第二次。
      term.onData((data) => {
        const now = performance.now()
        const handledData = recordTerminalInputFallbackHandledData({
          candidate: rt.keydownCandidate,
          data,
          history: rt.recentHandled,
          maxAgeMs: INPUT_FALLBACK_RECENT_DATA_MS,
          now,
        })
        rt.recentHandled = handledData.usedCandidate
          ? handledData.history
          : recordTerminalInputFallbackRecentData({
              data,
              history: handledData.history,
              maxAgeMs: INPUT_FALLBACK_RECENT_DATA_MS,
              now,
            })
        if (handledData.usedCandidate) {
          rt.keydownCandidate = null
        }
        markTerminalInputFallbackHandled(rt.inputFallbacks, data)
        writeInput(data)
      })

      // Windows 输入法兜底：composed text 留在 textarea 里而 xterm 没写完
      // 时补写一次（只收窄到 Windows——Wayland 下会和 onData 重复）。
      // textarea 在 term.open 之后才存在，故由 ensureSpawned 调用。
      const attachTextareaFallback = () => {
        const textarea = IS_WINDOWS ? term.textarea : undefined
        if (!textarea) return
        const handleInput = (event: Event) => {
          const e = event as InputEvent
          if (e.inputType !== 'insertText' || !e.data || !e.composed) return
          const insertedText = e.data
          const now = performance.now()
          const pendingFallback = createPendingTerminalInputFallback(insertedText)
          rt.inputFallbacks.push(pendingFallback)
          consumeTerminalInputFallbackHandledData({
            history: rt.recentHandled,
            inputEventTimeStamp: e.timeStamp,
            maxAgeMs: INPUT_FALLBACK_RECENT_DATA_MS,
            maxInputDelayMs: INPUT_FALLBACK_KEYDOWN_INPUT_MS,
            now,
            pending: pendingFallback,
          })
          setTimeout(() => {
            rt.inputFallbacks = rt.inputFallbacks.filter((item) => item !== pendingFallback)
            if (rt.cancelled) return
            const fallbackAction = resolveTerminalInputFallbackAction({
              pending: pendingFallback,
              textareaValue: textarea.value,
            })
            if (fallbackAction.shouldWrite) {
              writeInput(insertedText)
            }
            if (fallbackAction.shouldClearTextarea) {
              textarea.value = ''
            }
          }, INPUT_FALLBACK_FLUSH_DELAY_MS)
        }
        textarea.addEventListener('input', handleInput, true)
        rt.detachTextareaInput = () => textarea.removeEventListener('input', handleInput, true)
      }

      // ── 延迟启动（对齐 ZCode isVisible 语义）─────────────────────────────
      // 面板在后台/隐藏时容器是 0×0，xterm 只能按内置默认 80×24 fit。
      // 若此时就 spawn，PTY 先用 24 行启动、可见后 resize 到 60+ 行，
      // ConPTY/PSReadLine 会重绘旧屏——表现为 banner 与提示符重复出现、
      // 内容被推到屏幕中部（2026-11-15 用户实锤「终端文字全挤在一起」）。
      // 所以：**只有拿到真实尺寸才 spawn**；隐藏时由布局回调重试。
      const spawnPty = async (initial: TerminalSize) => {
        try {
          const spawned = await spawnTerminal({ cols: initial.cols, rows: initial.rows, cwd })
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
          setTabState(key, {
            status: 'ready',
            shellLabel: formatShellLabel(spawned.shell) ?? spawned.shell,
            cwd: spawned.cwd,
            projectName: terminalProjectName(spawned.cwd) ?? terminalProjectName(cwd),
          })

          // 订阅必须在 attach 之前：attach 之后的输出只走事件，
          // attach 之前的在 backlog 里（terminal.rs 模块头）。
          // 每次订阅落位后复查 cancelled：dispose 可能抢在 await 之间完成
          // （已 drain 过 rt.unlisten，晚到的订阅必须自己拆掉防泄漏）
          const outUn = await onTerminalOutput(spawned.id, (ev) => {
            // 已取消（页签关闭/重启）：unlisten 是异步的，队列里残留的事件
            // 不能再写进新实例（重启复用同一个 key）
            if (rt.cancelled) return
            writeOutput(rt.gate.push(base64ToBytes(ev.data)))
          })
          if (rt.cancelled) {
            outUn()
            return
          }
          rt.unlisten.push(outUn)

          const exitUn = await onTerminalExit(spawned.id, (ev) => {
            if (rt.cancelled) return
            const exit: TerminalExit = { exitCode: ev.exitCode, error: ev.error }
            if (!rt.attached) {
              // attach 回放还没落屏：先存着，等 backlog 写完再写退出行
              rt.pendingExit = exit
              return
            }
            applyExit(exit)
          })
          if (rt.cancelled) {
            exitUn()
            return
          }
          rt.unlisten.push(exitUn)

          // attach：回放 backlog（首屏 banner/提示符），此后事件直通
          const attached = await attachTerminal(spawned.id)
          if (rt.cancelled) return
          writeOutput(rt.gate.attachBacklog(base64ToBytes(attached.data)))
          rt.attached = true
          if (attached.exit) applyExit(attached.exit)
          if (rt.pendingExit) {
            const pending = rt.pendingExit
            rt.pendingExit = null
            applyExit(pending)
          }

          // id 就绪：flush 创建期间排队的 resize（否则相同尺寸被去重跳过）
          flushResize(rt)
          term.focus()
        } catch (err) {
          if (rt.cancelled) return
          console.error('[terminal] spawn failed:', err)
          const message = err instanceof Error ? err.message : String(err)
          // 失败必须可见：写进终端 + 页签转 error（退出条带"重新打开"）
          rt.exited = true
          writeOutput(rt.gate.finish())
          rt.term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
          setTabState(key, { status: 'error', error: message })
        }
      }

      /** 容器有真实尺寸才 open+启动；否则等 ResizeObserver/可见性回调重试。 */
      const ensureSpawned = () => {
        if (rt.cancelled || rt.spawnStarted) return
        const c = containerRef.current
        if (!c || c.clientWidth <= 0 || c.clientHeight <= 0) return
        rt.spawnStarted = true
        if (!rt.opened) {
          try {
            term.open(rt.hostEl)
            rt.opened = true
          } catch (err) {
            // 失败必须可见（规矩 12）：页签转 error，退出条给"重新打开"
            console.error('[terminal] open failed:', err)
            rt.exited = true
            setTabState(key, {
              status: 'error',
              error: err instanceof Error ? err.message : String(err),
            })
            return
          }
          attachTextareaFallback()
        }
        fitAndQueueResize(rt)
        const initial = rt.lastSentSize ?? { cols: term.cols, rows: term.rows }
        void spawnPty(initial)
      }
      rt.ensureSpawned = ensureSpawned
      ensureSpawned()
    },
    [fitAndQueueResize, flushResize, setTabState],
  )

  // ── 页签操作 ─────────────────────────────────────────────────────────────

  const addTab = useCallback(() => {
    seqRef.current += 1
    const key = `t${seqRef.current}`
    const index = nextTerminalIndex(tabsRef.current.map((t) => t.index))
    // 新终端开在当前会话的工作区（ZCode：terminal 用 workspace cwd）
    const cwd = pickTerminalCwd(sessionCatalog.getState())
    setTabs((ts) => [
      ...ts,
      {
        key,
        index,
        projectName: terminalProjectName(cwd),
        cwd: cwd ?? null,
        shellLabel: null,
        status: 'starting',
        exitCode: null,
        error: null,
      },
    ])
    activeKeyRef.current = key
    setActiveKey(key)
    createSession(key, cwd)
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
      const previous = tabsRef.current.find((t) => t.key === key)
      disposeSession(key)
      setTabState(key, {
        status: 'starting',
        exitCode: null,
        error: null,
        shellLabel: null,
      })
      createSession(key, previous?.cwd ?? undefined)
    },
    [createSession, disposeSession, setTabState],
  )

  // ── effects ──────────────────────────────────────────────────────────────

  // 挂载：建第一个页签。卸载（关窗格/布局重建/StrictMode 重跑）=
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
      // 一帧内可能已被关闭/重启（term 已 dispose，读 cols 会炸）
      if (rt.cancelled) return
      // 隐藏期间创建的页签：hostEl 归属活动签后才有真实尺寸，此时补启动
      rt.ensureSpawned?.()
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
        if (rt) {
          rt.ensureSpawned?.()
          fitAndQueueResize(rt)
        }
      })
    })
    ro.observe(container)
    return () => {
      ro.disconnect()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [fitAndQueueResize])

  // 面板重新可见（从「文件树/预览」切回终端、栏收放展开）：xterm 的 DOM
  // 在隐藏期间是被摘下来的，重新挂回后必须补 fit + focus——否则键盘焦点
  // 留在别处，用户以为终端"点不动"（ZCode 的 isVisible 语义）。
  useEffect(() => {
    if (!api) return
    const disposable = api.onDidVisibilityChange((event) => {
      if (!event.isVisible) return
      const key = activeKeyRef.current
      const rt = key ? sessionsRef.current.get(key) : undefined
      if (!rt) return
      requestAnimationFrame(() => {
        if (rt.cancelled) return
        rt.ensureSpawned?.()
        fitAndQueueResize(rt)
        rt.term.focus()
      })
    })
    return () => disposable.dispose()
  }, [api, fitAndQueueResize])

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

  const tabTitle = (t: TerminalTab) => formatTerminalTabTitle(t.projectName ?? '终端', t.index)
  const tabHint = (t: TerminalTab) => {
    const shell = t.shellLabel ?? '终端'
    const where = t.cwd ? ` — ${t.cwd}` : ''
    if (t.status === 'exited') return `${shell}${where}（进程已退出, code ${t.exitCode}）`
    if (t.status === 'error') return `${shell}${where}（启动失败）`
    return `${shell}${where}`
  }

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
              title={tabHint(t)}
              onClick={() => switchTab(t.key)}
            >
              {tabTitle(t)}
              {t.status === 'starting' ? '…' : ''}
            </button>
            <button
              type="button"
              className="term-tab-close"
              aria-label={`关闭 ${tabTitle(t)}`}
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
