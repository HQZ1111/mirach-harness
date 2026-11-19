"use client";

/**
 * 系统托盘动作桥（2026-11-19，ZCode `packages/desktop/src/main/desktopTray.ts`
 * 语义的宿主对偶）。
 *
 * Rust 侧托盘（main.rs setup）持有 OS 面：左键/双击 = 显示主窗，右键菜单 =
 * 打开 / 新建任务 / 打开工作区 / 关于 / 退出。其中「新建任务」「打开工作区」
 * 必须落在前端会话面——Rust 在 `show_main` 之后 `app.emit` 事件，主窗在这里
 * 消费（与 ZCode `executeTrayCommand = showCurrentWindow().then(executeDesktopCommand)`
 * 同序：先聚焦窗口再执行命令）：
 *
 * - `mirach:tray:new-task`       → 主区切聊天 + 走段头「新建会话」既有通道
 *   （`triggerNewChat`，与右键菜单「新建会话」同一个入口）。
 * - `mirach:tray:open-workspace` → 主区切聊天 + 系统文件夹对话框 →
 *   `sessionWorkspaceStore.requestCreate(cwd)`（与 composer 工作区行
 *   `pickFolder` 同一个请求-执行桥；用户取消不发请求）。
 *
 * ZCode 托盘菜单里的「检查更新」「导出日志」在宿主没有对等面（更新面在设置
 * 「关于 → 版本与更新」节，导出无入口），不渲染假菜单项。
 */
import { useEffect } from 'react'

import { triggerNewChat } from '@/components/layout/app-context-menu'
import { mainViewStore } from '@/components/panes/main-view-store'
import { sessionWorkspaceStore } from '@/components/panes/session-manage/session-workspace'
import { inTauri } from '@/lib/tauri-window'

export function TrayBridge() {
  useEffect(() => {
    if (!inTauri) return
    let disposed = false
    const offs: Array<() => void> = []

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const { open: openFileDialog } = await import('@tauri-apps/plugin-dialog')

        const offNewTask = await listen('mirach:tray:new-task', () => {
          mainViewStore.getState().showChat()
          triggerNewChat()
        })
        if (disposed) {
          offNewTask()
          return
        }
        offs.push(offNewTask)

        const offOpenWorkspace = await listen('mirach:tray:open-workspace', () => {
          mainViewStore.getState().showChat()
          void (async () => {
            try {
              const dir = await openFileDialog({ directory: true })
              if (typeof dir !== 'string' || dir.length === 0) return // 用户取消——不发请求
              sessionWorkspaceStore.getState().requestCreate(dir)
            } catch (e) {
              console.error('[tray] 打开文件夹对话框失败', e)
            }
          })()
        })
        if (disposed) {
          offOpenWorkspace()
          return
        }
        offs.push(offOpenWorkspace)
      } catch (e) {
        console.error('[tray] 托盘事件桥装载失败', e)
      }
    })()

    return () => {
      disposed = true
      for (const off of offs) off()
    }
  }, [])

  return null
}