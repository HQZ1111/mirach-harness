/**
 * 宿主 Tauri 窗口透明桥（2026-11-23 用户："这个直接做"）。
 *
 * hermes 的 `store/translucency.ts` 只认 `window.hermesDesktop` 上的 Electron
 * 主进程桥；宿主没有。这里在**任何主题/ translucency 模块求值之前**装上：
 *   - translucencySupported / glassSupported = true（Windows 11 Acrylic）；
 *   - setTranslucency(state)：Clear 用根节点 opacity 模拟整窗淡出（原生
 *     setOpacity 在 Tauri 无公开 API），Glass 用 `setEffects(Acrylic)` +
 *     `--translucency-glass-keep` 让宿主 surface 半透明。
 *
 * tauri.conf.json 的窗口必须 `transparent: true`；CSS 在 appearance.css 里把
 * body/#root 背景透明化，桌面才能透出来。
 */
import { Effect, EffectState, getCurrentWindow } from '@tauri-apps/api/window'

interface HostTranslucencyState {
  intensity: number
  fade?: number
  mode: 'clear' | 'glass'
}

const root = document.documentElement

function applyClear(intensity: number): void {
  if (intensity <= 0) {
    root.removeAttribute('data-hermes-clear')
    root.style.removeProperty('--clear-opacity')
    return
  }
  // 与 hermes 同一可读区间：0 → 1，100 → 0.3（不低于 30%，否则整窗不可用）。
  const opacity = Math.max(0.3, 1 - (intensity / 100) * 0.7)
  root.setAttribute('data-hermes-clear', '')
  root.style.setProperty('--clear-opacity', String(opacity))
}

function applyGlassFade(fade: number): void {
  if (fade <= 0) {
    root.style.removeProperty('--glass-fade-opacity')
  } else {
    root.style.setProperty('--glass-fade-opacity', String(Math.max(0.3, 1 - (fade / 100) * 0.7)))
  }
}

let effectMode: 'none' | 'glass' = 'none'

async function applyGlass(on: boolean): Promise<void> {
  const win = getCurrentWindow()
  if (on && effectMode !== 'glass') {
    await win.setEffects({ effects: [Effect.Acrylic], state: EffectState.Active })
    effectMode = 'glass'
  } else if (!on && effectMode === 'glass') {
    await win.clearEffects()
    effectMode = 'none'
  }
}

const bridge = ((window as unknown as { hermesDesktop?: Record<string, unknown> }).hermesDesktop ??= {})

bridge.translucencySupported = true
bridge.glassSupported = true
bridge.setTranslucency = async (raw: unknown): Promise<void> => {
  const state = (raw ?? {}) as HostTranslucencyState
  const intensity = Number(state.intensity) || 0
  const glass = state.mode === 'glass' && intensity > 0
  applyClear(state.mode === 'clear' ? intensity : 0)
  applyGlassFade(glass ? Number(state.fade) || 0 : 0)
  try {
    await applyGlass(glass)
  } catch (e) {
    // 效果失败不能静默：控制台可见；Clear 的 CSS 淡出仍可用。
    console.error('[translucency] 应用窗口材质失败', e)
  }
}

export {}
