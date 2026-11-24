/**
 * 应用级偏好的启动守卫（2026-11-15）。
 *
 * 只做"必须有全局监听者"的事：
 *   ① 禁用 F12：开发构建下页面级拦截（发布构建本身不开放 devtools，
 *      所以这个开关只对开发构建有意义——设置页文案如实标注）。
 *   ② 始终在外部浏览器打开链接：捕获阶段拦 http(s) 锚点，交宿主的
 *      `fs_open_url`（`cmd /c start`），不在应用内导航。
 *   ③ 自动归档旧会话的调度器（2026-11-22）：启动首轮 + 每 5 分钟扫描，
 *      设置变更立即补扫（见 lib/auto-archive）。仅主窗挂载本组件。
 *
 * 数据源 = lib/app-prefs 的订阅（Rust 落盘后的真值），设置页改完立即
 * 生效，无需重启。加载失败时守卫不生效，但**必须可见**（console.error）。
 */

import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

import { loadAppPrefs, subscribeAppPrefs, type AppPrefs } from '@/lib/app-prefs'
import { installAppearanceShortcuts } from '@/lib/appearance-prefs'
import { rescanAutoArchiveNow, startAutoArchiveScheduler } from '@/lib/auto-archive'

const HTTP_URL = /^https?:\/\//i

export function AppPrefsBoot() {
  useEffect(() => {
    let current: AppPrefs | null = null

    const onClick = (event: MouseEvent) => {
      if (current?.openLinksExternally !== true) return
      if (event.defaultPrevented || event.button !== 0) return
      const target = event.target
      if (!(target instanceof Element)) return
      const anchor = target.closest('a[href]')
      if (!(anchor instanceof HTMLAnchorElement)) return
      const href = anchor.getAttribute('href') ?? ''
      if (!HTTP_URL.test(href)) return
      event.preventDefault()
      event.stopPropagation()
      void invoke('fs_open_url', { url: href }).catch((error) => {
        console.error('[app-prefs] 外部浏览器打开失败', href, error)
      })
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (current?.disableF12 !== true) return
      if (event.key !== 'F12') return
      event.preventDefault()
      event.stopPropagation()
    }

    document.addEventListener('click', onClick, true)
    window.addEventListener('keydown', onKeyDown, true)
    const unsubscribe = subscribeAppPrefs((prefs) => {
      const before = current
      current = prefs
      // 自动归档设置变更 → 立即补扫（ZCode shouldRescanTaskAutoArchive 同款）。
      if (
        before !== null &&
        (before.taskAutoArchiveEnabled !== prefs.taskAutoArchiveEnabled ||
          before.taskAutoArchiveOlderThanDays !== prefs.taskAutoArchiveOlderThanDays)
      ) {
        rescanAutoArchiveNow()
      }
    })
    void loadAppPrefs().catch((error) => {
      console.error('[app-prefs] 偏好加载失败，F12 拦截 / 外链外部打开未生效', error)
    })
    // 自动归档调度器（主窗唯一实例；设置窗不挂载本组件）。
    const stopAutoArchive = startAutoArchiveScheduler()
    // 外观 → 界面缩放快捷键（Ctrl/Cmd + / - / 0）。
    const stopAppearanceShortcuts = installAppearanceShortcuts()

    return () => {
      stopAutoArchive()
      stopAppearanceShortcuts()
      document.removeEventListener('click', onClick, true)
      window.removeEventListener('keydown', onKeyDown, true)
      unsubscribe()
    }
  }, [])

  return null
}
