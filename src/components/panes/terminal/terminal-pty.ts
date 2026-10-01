/**
 * 终端 PTY 的 IPC 面——src-tauri/src/terminal.rs 五命令 + 两条 Tauri Event
 * 的前端侧封装。
 *
 * 事件通道裁定（terminal.rs 模块头）：终端是系统设施不是 Agent 数据，
 * 输出/退出走 Tauri Event，AG-UI 三通道纪律（§2.1 只管 Agent 数据流）
 * 在此不适用。
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

/** 输出事件载荷：data = PTY 原始字节的 base64（劈开的 UTF-8 序列靠流式 TextDecoder 还原） */
export interface TerminalOutputEvent {
  id: number
  data: string
}

/** 退出事件载荷：exitCode 缺 = wait 本身失败（error 说明原因） */
export interface TerminalExitEvent {
  id: number
  exitCode: number | null
  error: string | null
}

export function spawnTerminal(cols?: number, rows?: number): Promise<TerminalSpawned> {
  return invoke<TerminalSpawned>('terminal_spawn', { cols, rows })
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
