/**
 * 「技能与工具」页面入口（dockview `workspace` 面板的 capabilities 视图）。
 *
 * 2026-11-26 用户："技能与工具页面还有很多 hermes 的东西，只显示本地仓库的，
 * 去掉没用的"——页面主体换成宿主自己的 `LocalCapabilitiesPane`（只列
 * `pi_capabilities` 的本地技能/工具集），不再渲染 hermes `CapabilitiesView`
 * 的 技能/插件/连接器/工具集 四页签与 Skills Hub。
 *
 * 本文件保留的 `ensureCapabilitiesWiring` 仍是**插件的 Bot 编辑高级页**与
 * `cron` 面板需要的宿主桥（它们按上游 CapabilitiesView 形态渲染，数据面
 * 走这里的 `window.hermesDesktop.api` 路由）——只是主区页面不用那套壳。
 */

import { installHostBridge, setBridgeWorkspaceCwd } from '@/hermes-shim/bridge'
import { setCapabilitiesWorkspaceCwd } from '@/hermes-shim/hermes'
import { inTauri } from '@/lib/tauri-window'

import { sessionCatalog, sessionProjectCwd } from '@/components/panes/session-manage/session-catalog'
import { LocalCapabilitiesPane } from '@/components/panes/local-capabilities-pane'

/** pi 的项目级配置（.pi/mcp.json、.pi/extensions）以活动会话的工作区为根；
 *  能力页没有会话上下文，所以从宿主的会话目录取。 */
function activeWorkspaceCwd(): string | null {
  const state = sessionCatalog.getState()
  const entry = state.activeId ? state.entries[state.activeId] : undefined
  return sessionProjectCwd(entry, state.pendingCwd) ?? null
}

let wired = false

/** 桥只装一次（模块级副作用留给显式调用方——App 挂载时）。 */
export function ensureCapabilitiesWiring(): void {
  if (wired || !inTauri) {
    return
  }

  wired = true
  installHostBridge()
  const read = () => activeWorkspaceCwd()
  setBridgeWorkspaceCwd(read)
  setCapabilitiesWorkspaceCwd(read)
}

/** 技能与工具视图：宿主本地清单页（技能 + 工具集 + 诊断）。 */
export function CapabilitiesPane() {
  return <LocalCapabilitiesPane />
}
