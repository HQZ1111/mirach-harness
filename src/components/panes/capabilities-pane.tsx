/**
 * 「技能与工具」页面入口（dockview `workspace` 面板的 capabilities 视图）。
 *
 * 2026-10-28：用户要求"完整复刻 hermes 桌面端的技能与中心"——上一版是手写的
 * 近似实现（结构对齐但组件与视觉都是重写），已整体删除。现在**真的搬运**
 * hermes 的组件树：`src/hermes-mirror/app/capabilities/`（95 个上游文件逐字
 * 复制）+ 宿主边界适配层 `src/hermes-shim/`（把 hermes 的 REST 数据面接到
 * pi IPC 上，见 shim 各文件头）。
 *
 * 本文件只做三件事（数据接线见各注释）：
 *  1. 挂上游 `I18nProvider`（语言 = 宿主偏好 `mirach:locale`）；
 *  2. 装宿主桥（`window.hermesDesktop.api` → pi IPC 路由表）；
 *  3. 渲染上游 `CapabilitiesView`。
 */

import { QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/hermes-mirror/i18n'
import { CapabilitiesView } from '@/hermes-mirror/app/capabilities'
import { installHostBridge, setBridgeWorkspaceCwd } from '@/hermes-shim/bridge'
import { setCapabilitiesWorkspaceCwd } from '@/hermes-shim/hermes'
import { queryClient } from '@/hermes-shim/lib/query-client'
import { inTauri } from '@/lib/tauri-window'

import { sessionCatalog, sessionProjectCwd } from '@/components/panes/session-manage/session-catalog'

/** 语言偏好：宿主设置页写的 `mirach:locale`（zh-CN | en）。上游 locale 是
 *  'en' | 'zh' | …，这里做一次归一。 */
function hostLocale(): 'en' | 'zh' {
  try {
    return new URLSearchParams(window.location.search).get('lang') === 'en' ||
      localStorage.getItem('mirach:locale') === 'en'
      ? 'en'
      : 'zh'
  } catch {
    return 'zh'
  }
}

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

/** 技能与工具视图（hermes `CapabilitiesView` 的宿主挂载点）。
 *
 *  `QueryClientProvider` 是**必须**的：上游页面（scope-selector / skills-data /
 *  catalog-data / mcp / toolsets / 连接器 queries）全部走 TanStack Query，而
 *  上游的 Provider 挂在它自己的 App 根上。宿主把能力页嵌在 dockview 面板里，
 *  所以 Provider 挂在这里；实例用 shim 的 `queryClient`（上游同一份，含
 *  model-options 的 structuralSharing 配置），不是新建一个。 */
export function CapabilitiesPane() {
  ensureCapabilitiesWiring()

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={hostLocale()}>
        <CapabilitiesView className="hermes-capabilities-host" />
      </I18nProvider>
    </QueryClientProvider>
  )
}
