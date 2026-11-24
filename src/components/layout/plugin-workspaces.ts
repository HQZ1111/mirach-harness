/**
 * 插件工作区门（`host.openWorkspace(id, options)` 的宿主对偶）。
 *
 * 上游契约（`apps/desktop` 的 host.openWorkspace）：插件传入
 * `{ title, render, onClose, minWidth? }`，宿主在**主窗**开一个标签页并把
 * `render()` 挂进去，返回关闭函数；关标签时回调 `onClose`。hermes-bots 的
 * 群聊房间就是走这门（`group-chat-view.tsx::openGroupChat` —— 房间是主区
 * 标签，不是侧栏窗格；`shouldRenderGroupChatInPane stays false throughout`）。
 *
 * 宿主此前只派发了 `mirach:open-workspace` 自定义事件、**没有任何监听者**
 * ——点群聊行毫无反应（`$groupChatWorkspace` 被设了，但渲染分支按上游语义
 * 恒 false；openWorkspace 还吞掉了 close 返回值）。这里补上真正的门：
 *
 * - 记录表（id → {title, render, onClose}）：dockview 面板参数只带 id，
 *   渲染面从记录表取（render 是插件闭包，必须留在内存，不序列化）；
 * - dockview 面板 = `plugin:<id>`，component `plugin-workspace`，落在主区
 *   （chat 组）作标签页；
 * - 关标签（用户 ✕ / 插件调 close）→ `onClose()` + 记录清理。
 */

import type { ReactNode } from 'react'
import type { DockviewApi } from 'dockview-react'

import { CHAT_MIN_WIDTH } from './rail-metrics'

export interface PluginWorkspaceOptions {
  title?: string
  render?: () => ReactNode
  onClose?: () => void
  minWidth?: string
}

interface WorkspaceRecord {
  title: string
  render?: () => ReactNode
  onClose?: () => void
}

const records = new Map<string, WorkspaceRecord>()
const listeners = new Set<() => void>()
let version = 0

/** 订阅记录表变化（面板组件渲染用；快照按 version 失效）。 */
export function subscribePluginWorkspaces(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function pluginWorkspacesVersion(): number {
  return version
}

export function pluginWorkspaceRecord(id: string): WorkspaceRecord | null {
  return records.get(id) ?? null
}

function bump(): void {
  version += 1
  listeners.forEach((l) => l())
}

function apiOf(): DockviewApi | null {
  return (globalThis as { __dvApi?: DockviewApi }).__dvApi ?? null
}

/** 主区落点：先挤进 chat 组（workspace 所在），缺席才退右分栏。 */
function workspaceDropPosition(a: DockviewApi) {
  if (a.getPanel('workspace')) return { referencePanel: 'workspace', direction: 'within' as const }
  if (a.getPanel('leftrail')) return { referencePanel: 'leftrail', direction: 'right' as const }
  return undefined
}

/**
 * 开出/置前一个插件工作区，返回关闭函数（上游 `host.openWorkspace` 的返回
 * 契约——插件把它存起来用于程序化关闭）。
 */
export function openPluginWorkspace(id: string, options: PluginWorkspaceOptions = {}): () => void {
  const title = options.title?.trim() || id
  records.set(id, { title, render: options.render, onClose: options.onClose })
  bump()

  const a = apiOf()
  if (!a) {
    // 布局未就绪 = 调用发生在 shell 挂载前；错误可见不静默（规矩 12）。
    console.error('[plugin-workspace] dockview api 不在场——工作区未打开', id)
    return () => closePluginWorkspace(id)
  }
  const existing = a.getPanel(id)
  if (existing) {
    existing.api.setActive()
    return () => closePluginWorkspace(id)
  }
  try {
    a.addPanel({
      id,
      component: 'plugin-workspace',
      title,
      minimumWidth: CHAT_MIN_WIDTH,
      params: { workspaceId: id },
      ...(workspaceDropPosition(a) ? { position: workspaceDropPosition(a) } : {}),
    })
  } catch (e) {
    console.error('[plugin-workspace] 打开失败', id, e)
    records.delete(id)
    bump()
    throw e
  }
  return () => closePluginWorkspace(id)
}

/** 关闭一个插件工作区（幂等）。 */
export function closePluginWorkspace(id: string): void {
  const a = apiOf()
  const panel = a?.getPanel(id)
  if (panel) {
    panel.api.close()
    return
  }
  // 面板已不在场：直接走关闭清理。
  workspacePanelClosed(id)
}

/**
 * dockview 面板移除通知（shell 的 onDidRemovePanel 调用）——回调插件
 * `onClose`（它借此丢弃 main-tab 记录）并清掉记录。
 */
export function workspacePanelClosed(id: string): void {
  const record = records.get(id)
  if (!record) return
  records.delete(id)
  bump()
  try {
    record.onClose?.()
  } catch (e) {
    console.error('[plugin-workspace] onClose 抛错', id, e)
  }
}

/**
 * 清掉布局存档恢复出来的**孤儿工作区面板**（boot 期 fromJSON 之后调用）。
 *
 * 记录表是进程内存：重启后存档里的 `plugin-workspace` 面板没有 render 可挂
 * （hermes 的 main-tab 也是窗口内记录，重启不复活）。**必须在 React 子树挂载
 * 前/外关闭**——面板组件在 mount effect 里调 `api.close()` 会在 fromJSON 的
 * 恢复过程中抛 dockview "invalid operation"，把整块布局带崩（实测）。
 */
export function pruneOrphanWorkspacePanels(a: DockviewApi): void {
  for (const panel of [...a.panels]) {
    const component = (panel as unknown as { view?: { contentComponent?: string } }).view
      ?.contentComponent
    if (component !== 'plugin-workspace') continue
    if (pluginWorkspaceRecord(panel.id)) continue
    console.warn(`[plugin-workspace] ${panel.id} 无记录（重启恢复）——关闭孤儿面板`)
    try {
      a.removePanel(panel)
    } catch (e) {
      console.error('[plugin-workspace] 孤儿面板移除失败', panel.id, e)
    }
  }
}
