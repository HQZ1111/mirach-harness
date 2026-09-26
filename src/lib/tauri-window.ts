/**
 * Tauri 窗口桥 —— 自绘标题栏的最小封装。纯浏览器 dev（vite 直开）时
 * inTauri=false，窗口控制按钮不渲染/不动作。
 */

import { getCurrentWindow } from '@tauri-apps/api/window'

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/** Tauri 窗口实例；浏览器里为 null */
export const appWindow = inTauri ? getCurrentWindow() : null
