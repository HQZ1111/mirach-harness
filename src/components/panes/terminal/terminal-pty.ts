/**
 * 终端 PTY 的 IPC 面——src-tauri/src/terminal.rs 六命令 + 两条 Tauri Event
 * 的前端侧封装。
 *
 * 事件通道裁定（terminal.rs 模块头）：终端是系统设施不是 Agent 数据，
 * 输出/退出走 Tauri Event，AG-UI 三通道纪律（§2.1 只管 Agent 数据流）
 * 在此不适用。
 *
 * 【attach 是首屏输出的第二条腿】输出事件只在**订阅之后**才收得到
 * （Tauri Event 无监听者即丢弃）。spawn→订阅之间 shell 的 banner/首个
 * 提示符已经可能写出，所以宿主把它们存进 backlog，由 `attachTerminal`
 * 一次性回放；未订阅到就退出的会话也靠它补发退出态。订阅顺序必须是
 * 先 listen、后 attach（见 terminal-pane.tsx）。
 */

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type { UnlistenFn }

export interface TerminalSpawned {
  id: number
  /** shell 原串（页签名经 formatShellLabel 归一） */
  shell: string
  cwd: string
}

/** 退出信息（终端事件与 attach 回放共用形状） */
export interface TerminalExit {
  exitCode: number | null
  error: string | null
}

/** 输出事件载荷：data = PTY 原始字节的 base64（劈开的 UTF-8 序列靠流式 TextDecoder 还原） */
export interface TerminalOutputEvent {
  id: number
  data: string
}

/** 退出事件载荷：exitCode 缺 = wait 本身失败（error 说明原因） */
export interface TerminalExitEvent extends TerminalExit {
  id: number
}

/** attach 回包：data = 未送达输出的 base64（空串 = 没有），exit = 已退出时的退出信息 */
export interface TerminalAttached {
  data: string
  exit: TerminalExit | null
}

/**
 * 开新 PTY。cwd = 当前会话工作区（缺省 = 系统 home，裁定见 terminal.rs
 * 模块头【cwd 裁定】）；cols/rows = 前端先 fit 出来的真实尺寸。
 */
export function spawnTerminal(params: {
  cols?: number
  rows?: number
  cwd?: string
}): Promise<TerminalSpawned> {
  return invoke<TerminalSpawned>('terminal_spawn', {
    cols: params.cols,
    rows: params.rows,
    cwd: params.cwd,
  })
}

/** 取走 attach 前的 backlog + 退出补发；此后输出走 terminal-output 事件 */
export function attachTerminal(id: number): Promise<TerminalAttached> {
  return invoke<TerminalAttached>('terminal_attach', { id })
}

export function writeTerminal(id: number, data: string): Promise<void> {
  return invoke('terminal_write', { id, data })
}

export function resizeTerminal(id: number, cols: number, rows: number): Promise<void> {
  return invoke('terminal_resize', { id, cols, rows })
}

export function killTerminal(id: number): Promise<void> {
  return invoke('terminal_kill', { id })
}

/** 系统默认浏览器打开终端里的 http(s) 链接（Rust 侧再校验协议） */
export function openTerminalUrl(url: string): Promise<void> {
  return invoke('terminal_open_url', { url })
}

export function onTerminalOutput(
  id: number,
  handler: (ev: TerminalOutputEvent) => void,
): Promise<UnlistenFn> {
  return listen<TerminalOutputEvent>(`terminal-output:${id}`, (e) => handler(e.payload))
}

export function onTerminalExit(
  id: number,
  handler: (ev: TerminalExitEvent) => void,
): Promise<UnlistenFn> {
  return listen<TerminalExitEvent>(`terminal-exit:${id}`, (e) => handler(e.payload))
}
