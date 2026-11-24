/**
 * 终端窗格（真终端）——**一个窗格 = 一个终端会话**。
 *
 * 结构照抄 ZCode 侧栏终端（2026-11-17 对齐）：
 *   - 上游 `SidePaneTerminalPane.tsx`：`<section class="h-full min-h-0
 *     overflow-hidden bg-background p-3">` + 单个 `TerminalSession`，
 *     **内部不嵌第二层 terminal tabs、也没有第二层新建终端按钮**
 *     （`docs/ui/side-pane-terminal-tabs.md` 行为定义第 3 条）；
 *   - 多终端 = 面板栏的多个标签（见 `open-page-actions.ts` 的
 *     `openTerminalPanel`：每次点「终端」新建一个面板，标题 = cwd 末段 +
 *     序号，对应上游 `useAppPanels.createTerminalSidePaneTitle`）；
 *   - 终端面板以 `renderer: 'always'` 挂载：切到别的标签时内容不卸载、
 *     PTY 不中断（上游"切换到其他 side pane tab 或收起 side pane 时保持
 *     挂载"）；关闭标签才卸载本组件 = kill 该 PTY（上游关闭 tab 同语义）。
 *     隐藏面板容器报的是整坞尺寸（overlay 未定位），所以 spawn/fit 以
 *     `api.isVisible` 为准，激活时补启动。
 *
 * 会话内部仍逐段照抄 ZCode `TerminalSession.tsx`：
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
 *
 * 【首屏输出】spawn 返回后才有 id，订阅事件之前 shell 已经可能写过 banner
 * ——宿主把这些字节存进 backlog，`terminal_attach` 一次性回放；未订阅就
 * 退出的会话同样靠 attach 的 exit 补发（否则页签永远停在"运行中"）。
 *
 * 【生命周期】窗格卸载（关窗格/布局重建）= kill 该会话（清理路径定稿）；
 * 应用退出由 Rust TerminalRegistry::drop 兜底。StrictMode 双挂载：
 * cancelled 守卫——卸载时未就绪的 spawn 被识别为孤儿 PTY 立即回收。
 */

import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import type { ILink } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import type { DockviewPanelApi } from 'dockview-react'
import { ClipboardPaste, Copy } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { sessionCatalog } from '@/components/panes/session-manage/session-catalog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/motion/context-menu'
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
import { base64ToBytes } from './terminal/terminal-format'
import { normalizePowerShellReadlineRedraw } from './terminal/terminal-data-transform'
import { getHttpLinksForTerminalBufferLine } from './terminal/terminal-links'
import { TerminalOutputGate } from './terminal/terminal-output-gate'
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
import { appearanceStore } from '@/lib/appearance-prefs'

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

type TerminalStatus = 'starting' | 'ready' | 'exited' | 'error'

/** 会话运行时对象（xterm + PTY 订阅）——React 状态之外，ref 持有 */
interface TerminalSessionRT {
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
  /** StrictMode 卸载竞态：spawn 未就绪的会话被标记后回收孤儿 PTY */
  cancelled: boolean
  unlisten: UnlistenFn[]
  /** 外观 → 终端字体：设置变化时热更新 xterm.options。 */
  fontUnsubscribe: (() => void) | null
  detachTextareaInput: (() => void) | null
  pendingSize: TerminalSize | null
  lastSentSize: TerminalSize | null
  resizeInFlight: boolean
  /** xterm.open 已执行（隐藏面板延迟到可见时，见 ensureSpawned） */
  opened: boolean
  /** PTY 已启动（延迟启动的幂等闸门，见 ensureSpawned） */
  spawnStarted: boolean
  /** 有效尺寸就绪后 fit+spawn；面板隐藏/零尺寸时由布局回调重试 */
  ensureSpawned: (() => void) | null
  // ── Windows 输入法 composed text 兜底（ZCode 同源状态） ──
  inputFallbacks: PendingTerminalInputFallback[]
  keydownCandidate: TerminalInputFallbackKeydownCandidate | null
  recentHandled: TerminalInputFallbackHandledData[]
}

export function TerminalPane({ api, cwd }: { api?: DockviewPanelApi; cwd?: string }) {
  // 终端宿主：命令式管理（React 不掺和它的子节点）
  const containerRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<TerminalSessionRT | null>(null)
  /**
   * 面板可见性（ZCode `isVisible` 语义）。**保持挂载的 `renderer:'always'`
   * 面板在隐藏时容器仍报整坞尺寸**（dockview 的 overlay 未定位前默认
   * 100%×100%）——所以"有尺寸就 spawn"不足以判断，必须同时可见：
   * 隐藏的终端不 spawn、不 fit，等激活（onDidVisibilityChange）再补。
   */
  const panelVisibleRef = useRef(api ? api.isVisible : true)
  /** 页面级状态（页签状态 = 面板状态，本窗格只有一个会话） */
  const [status, setStatus] = useState<TerminalStatus>('starting')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** 重启用：最近一次会话的 cwd（spawn 返回的为准，其次面板参数） */
  const cwdRef = useRef<string | undefined>(cwd ?? pickTerminalCwd(sessionCatalog.getState()))

  const resetStatus = useCallback(() => {
    setStatus('starting')
    setExitCode(null)
    setError(null)
  }, [])

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
      // 隐藏（含 renderer:'always' 未激活）不给 fit：容器尺寸此刻不可信
      if (!panelVisibleRef.current) return
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

  const disposeSession = useCallback(() => {
    const rt = sessionRef.current
    if (!rt) return
    rt.cancelled = true
    for (const un of rt.unlisten) un()
    rt.unlisten = []
    rt.fontUnsubscribe?.()
    rt.fontUnsubscribe = null
    rt.detachTextareaInput?.()
    rt.detachTextareaInput = null
    if (rt.ptyId != null) {
      // 关闭 = kill（退出码事件随后到达，会话已不在，事件被丢弃）
      killTerminal(rt.ptyId).catch((err) => console.error('[terminal] kill on close failed:', err))
    }
    // xterm 5.5 的 Viewport 构造函数里有一个未被追踪的
    // setTimeout(syncScrollArea)，同步 dispose 会让它命中已释放的 render
    // service（"Cannot read properties of undefined (reading 'dimensions')"）。
    // 延后一个宏任务 dispose：让该定时器先跑完，再释放。
    const term = rt.term
    setTimeout(() => {
      try {
        term.dispose()
      } catch (err) {
        console.error('[terminal] term dispose failed:', err)
      }
    }, 0)
    rt.hostEl.remove()
    sessionRef.current = null
  }, [])

  const createSession = useCallback(
    (initialCwd: string | undefined) => {
      const container = containerRef.current
      if (!container) {
        // 容器缺席 = 布局竞态。禁止留一个永远 "starting" 的状态（规矩 12：
        // 失败必须可见），转 error，退出条会显示原因并给"重新打开"。
        console.error('[terminal] 容器不在场——会话未创建')
        setStatus('error')
        setError('终端容器不在场（布局未就绪）')
        return
      }

      const hostEl = document.createElement('div')
      hostEl.className = 'term-host'
      container.replaceChildren(hostEl)

      const font = getTerminalFont()
      const term = new XTerm({
        fontSize: font.fontSize,
        fontFamily: font.fontFamily,
        // 终端背景跟栏面走：开启背景图时 xterm viewport 不能刷一层不透明白。
        allowTransparency: true,
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
        fontUnsubscribe: null,
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
      sessionRef.current = rt

      // 设置 → 外观 → 终端字体：已有终端也即时换字体（新终端本来就读令牌）。
      rt.fontUnsubscribe = appearanceStore.subscribe(() => {
        const next = getTerminalFont()
        term.options.fontFamily = next.fontFamily
        term.options.fontSize = next.fontSize
        // 主题 / 背景图开关也会改变终端底色（背景图开启时透明）。
        term.options.theme = getTerminalTheme()
      })

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

      /** 退出落地：写提示 + 状态转 exited（事件与 attach 回放可能各来一次） */
      const applyExit = (exit: TerminalExit) => {
        if (rt.exited || rt.cancelled) return
        rt.exited = true
        // 冲掉解码器里悬挂的多字节尾巴（最后一块可能劈开一个汉字）
        writeOutput(rt.gate.finish())
        const line = exit.error
          ? `\r\n\x1b[31m${exit.error}\x1b[0m\r\n`
          : `\r\n\x1b[2m进程已退出 (code ${exit.exitCode})\x1b[0m\r\n`
        rt.term.write(line)
        setStatus('exited')
        setExitCode(exit.exitCode)
        setError(exit.error)
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
          const spawned = await spawnTerminal({ cols: initial.cols, rows: initial.rows, cwd: initialCwd })
          if (rt.cancelled) {
            // 卸载竞态：孤儿 PTY 立即回收，不进会话
            killTerminal(spawned.id).catch((err) =>
              console.error('[terminal] orphan kill failed:', err),
            )
            return
          }
          rt.ptyId = spawned.id
          rt.shell = spawned.shell
          if (spawned.cwd) cwdRef.current = spawned.cwd
          if (IS_WINDOWS) term.options.windowsPty = { backend: 'conpty' }
          setStatus('ready')

          // 订阅必须在 attach 之前：attach 之后的输出只走事件，
          // attach 之前的在 backlog 里（terminal.rs 模块头）。
          // 每次订阅落位后复查 cancelled：dispose 可能抢在 await 之间完成
          // （已 drain 过 rt.unlisten，晚到的订阅必须自己拆掉防泄漏）
          const outUn = await onTerminalOutput(spawned.id, (ev) => {
            // 已取消（关闭/重启）：unlisten 是异步的，队列里残留的事件
            // 不能再写进已 dispose 的 xterm
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
          // 失败必须可见：写进终端 + 状态转 error（退出条带"重新打开"）
          rt.exited = true
          writeOutput(rt.gate.finish())
          rt.term.write(`\r\n\x1b[31m${message}\x1b[0m\r\n`)
          setStatus('error')
          setError(message)
        }
      }

      /** 容器有真实尺寸且面板可见才 open+启动；否则等可见性/尺寸回调重试。 */
      const ensureSpawned = () => {
        if (rt.cancelled || rt.spawnStarted) return
        if (!panelVisibleRef.current) return
        const c = containerRef.current
        if (!c || c.clientWidth <= 0 || c.clientHeight <= 0) return
        rt.spawnStarted = true
        if (!rt.opened) {
          try {
            term.open(rt.hostEl)
            rt.opened = true
          } catch (err) {
            // 失败必须可见（规矩 12）：状态转 error，退出条给"重新打开"
            console.error('[terminal] open failed:', err)
            rt.exited = true
            setStatus('error')
            setError(err instanceof Error ? err.message : String(err))
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
    [fitAndQueueResize, flushResize],
  )

  const restartSession = useCallback(() => {
    disposeSession()
    resetStatus()
    createSession(cwdRef.current)
  }, [createSession, disposeSession, resetStatus])

  // ── effects ──────────────────────────────────────────────────────────────

  // 挂载：建会话。卸载（关窗格/布局重建/StrictMode 重跑）= kill 本会话
  // （清理路径定稿）；应用退出由 Rust Drop 兜底。
  useEffect(() => {
    if (!inTauri) return
    resetStatus()
    createSession(cwdRef.current)
    return () => {
      disposeSession()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 容器尺寸变化（分隔条拖拽/整栏 resize）→ fit 会话 → 排队后端 resize
  useEffect(() => {
    const container = containerRef.current
    if (!container || !inTauri) return
    let raf = 0
    const ro = new ResizeObserver(() => {
      if (raf) cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = 0
        const rt = sessionRef.current
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

  // 面板重新可见（从「文件树/预览」切回终端、栏收放展开、终端标签间切换）：
  // 隐藏期间 xterm 的 DOM 可能被摘走/不可见，重新可见后必须补启动 + fit +
  // focus——否则键盘焦点留在别处，用户以为终端"点不动"（ZCode isVisible 语义）。
  // 尺寸变化事件（onDidDimensionsChange）是第二道保险：overlay 定位写入后
  // dockview 会按新尺寸回调，隐藏期被跳过的 fit 在这里补齐。
  useEffect(() => {
    if (!api) return
    panelVisibleRef.current = api.isVisible
    const refit = () => {
      const rt = sessionRef.current
      if (!rt || rt.cancelled || !panelVisibleRef.current) return
      rt.ensureSpawned?.()
      fitAndQueueResize(rt)
    }
    const visibility = api.onDidVisibilityChange((event) => {
      panelVisibleRef.current = event.isVisible
      if (!event.isVisible) return
      // 等 dockview 把 overlay 定位写进样式（它的 rAF 先于本回调的 rAF）
      requestAnimationFrame(() => {
        refit()
        sessionRef.current?.term.focus()
      })
    })
    const dimensions = api.onDidDimensionsChange(() => {
      if (!panelVisibleRef.current) return
      refit()
    })
    return () => {
      visibility.dispose()
      dimensions.dispose()
    }
  }, [api, fitAndQueueResize])

  // ── 右键菜单（ZCode TerminalSession 的复制/粘贴菜单） ─────────────────────
  // 窗格根带 data-slot="terminal-pane"，已在全局右键范围登记为 owned
  // （context-menu-scope.ts）——全局监听早退，这里自己开菜单。

  const [menuPoint, setMenuPoint] = useState<{ x: number; y: number } | null>(null)

  /** 复制选区（无选区不动作——ZCode 同款：复制是"有则复制"的动作） */
  const copySelection = useCallback(() => {
    const term = sessionRef.current?.term
    if (!term) return
    if (term.hasSelection()) {
      void navigator.clipboard
        .writeText(term.getSelection())
        .catch((err) => console.error('[terminal] copy failed:', err))
    }
    // 菜单关闭后键盘焦点还给终端（否则原地打字进不了 PTY）
    term.focus()
  }, [])

  /** 粘贴剪贴板（xterm paste 走 bracketed-paste 语义，与 Ctrl+V 同路径） */
  const pasteClipboard = useCallback(() => {
    const term = sessionRef.current?.term
    if (!term) return
    term.focus()
    void navigator.clipboard
      .readText()
      .then((text) => {
        if (text) term.paste(text)
      })
      .catch((err) => console.error('[terminal] paste failed:', err))
  }, [])

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

  const showExitBar = status === 'exited' || status === 'error'

  return (
    <div
      className="term-pane"
      data-slot="terminal-pane"
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuPoint({ x: e.clientX, y: e.clientY })
      }}
    >
      <div className="term-body">
        <div ref={containerRef} className="term-host-container" />
        {showExitBar && (
          <div className="term-exit-bar">
            <span>
              {status === 'error'
                ? `终端启动失败：${error ?? '未知错误'}`
                : (error ?? `进程已退出 (code ${exitCode})`)}
            </span>
            <button type="button" className="term-exit-reopen" onClick={restartSession}>
              重新打开
            </button>
          </div>
        )}
      </div>
      {/* 右键菜单（受控 point——bots-pane 同款形态）。
          **必须 portal 到 body**：终端面板走 renderer:'always'，内容在
          .dv-render-overlay 里（它带 transform/contain，会给 position:fixed
          建包含块）——直接内联渲染时菜单的 fixed 坐标会被叠加 overlay 偏移
          （实测 x=1619 被画到 3030）。portal 到 body 后恢复视口坐标。 */}
      {createPortal(
        <ContextMenu
          onOpenChange={(open) => {
            if (!open) setMenuPoint(null)
          }}
          open={menuPoint !== null}
          point={menuPoint ?? { x: 0, y: 0 }}
        >
          <ContextMenuContent>
            <ContextMenuItem onSelect={copySelection}>
              <Copy className="mr-1.5 size-[var(--size-icon-sm)]" />
              复制
            </ContextMenuItem>
            <ContextMenuItem onSelect={pasteClipboard}>
              <ClipboardPaste className="mr-1.5 size-[var(--size-icon-sm)]" />
              粘贴
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>,
        document.body,
      )}
    </div>
  )
}
