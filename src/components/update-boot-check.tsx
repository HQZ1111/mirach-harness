/**
 * 启动时自动检查更新（2026-11-27 用户："能进行软件内更新推送吗"）。
 *
 * 只在**主窗**挂载（`main.tsx` 的 App 分支）。行为：
 *   · 偏好 `mirach:update.auto-check.v1` 开启才执行，默认关；
 *   · 后台 `check()` GitHub Releases，不阻塞界面；
 *   · 有新版本 → 发一条系统通知（复用宿主 `pi_notify`，受通知总开关约束），
 *     提示用户到「设置 → 版本与更新」确认安装；
 *   · **不自动下载/安装**（安装必须有用户确认，不静默替换正在运行的程序）；
 *   · 检查失败只 console.error（启动早期弹错会打扰用户；手动检查有可见错误）。
 */
import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'

import { autoCheckEnabled, checkForUpdate } from '@/lib/app-updater'
import { readNotifyPrefs } from '@/lib/notification-prefs'

export function UpdateBootCheck() {
  useEffect(() => {
    if (!autoCheckEnabled()) return
    let cancelled = false
    void checkForUpdate()
      .then((update) => {
        if (cancelled || !update) return
        const version = update.version
        void update.close().catch((e) => console.error('[updater] 释放更新资源失败', e))
        if (!readNotifyPrefs().enabled) return
        void invoke('pi_notify', {
          title: `Mirach Harness ${version} 可用`,
          body: '打开 设置 → 版本与更新 检查并安装。',
          silent: true,
        }).catch((e: unknown) => console.error('[updater] 更新通知发送失败', e))
      })
      .catch((e: unknown) => {
        console.error('[updater] 启动自动检查失败', e)
      })
    return () => {
      cancelled = true
    }
  }, [])

  return null
}
