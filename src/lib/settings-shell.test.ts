import { describe, expect, it } from 'vitest'
import { settingsShellFor, settingsShellFromProbe } from './settings-shell'

describe('settingsShellFor —— 设置入口形态决策', () => {
  it('浏览器直开 → overlay（不能 invoke：__TAURI_INTERNALS__ 不存在）', () => {
    expect(settingsShellFor({ inTauri: false, isMobile: false })).toBe('overlay')
  })

  it('浏览器直开 + 移动 UA → 仍是 overlay（inTauri 是更硬的判据）', () => {
    // 手机浏览器访问 web 版：没有 Tauri，两条判据都指向 overlay，
    // 但 inTauri 优先——不能被 isMobile 提前分走
    expect(settingsShellFor({ inTauri: false, isMobile: true })).toBe('overlay')
  })

  it('桌面 Tauri → window（跳过探测，少一次 IPC）', () => {
    expect(settingsShellFor({ inTauri: true, isMobile: false })).toBe('window')
  })

  it('移动端 Tauri → probe（同一 APK 在不同设备答案不同，必须运行时问）', () => {
    expect(settingsShellFor({ inTauri: true, isMobile: true })).toBe('probe')
  })
})

describe('settingsShellFromProbe —— 探测结果 → 最终形态', () => {
  it('支持多窗口（Android 12L+ / iPad）→ window', () => {
    expect(settingsShellFromProbe(true)).toBe('window')
  })

  it('不支持（iPhone / 旧 Android）→ overlay', () => {
    expect(settingsShellFromProbe(false)).toBe('overlay')
  })
})
