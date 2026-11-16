/**
 * 插件贡献窗格宿主 —— 把 `registry.getArea('panes')` 里某条渲染型
 * contribution 挂进 dockview 的既存窗格。
 *
 * hermes 的窗格系统由插件的 `data.placement` / `dock` 描述驱动（自动分栏、
 * 开合、置顶）；宿主 dockview 的布局是自管的（`dockview-shell` 的 components
 * 表 + 布局存档），没有通用的"按贡献自动建窗格"引擎。所以这里做**窄对偶**：
 * 宿主已有的窗格槽位（例如 `bots`）渲染对应 contribution，落位/开合仍归
 * 宿主布局。
 *
 * `fallback` = 该贡献尚未注册时（插件加载中 / 被禁用）渲染的宿主原生面板。
 * 这不是错误兜底：插件禁用时本来就该看到原生面；注册失败由设置页的插件
 * 记录标 error，两个面都可见。
 */

import { QueryClientProvider } from '@tanstack/react-query'

import { I18nProvider } from '@/hermes-mirror/i18n'
import { useContributions } from '@/hermes-shim/contrib/react/use-contributions'
import { queryClient } from '@/hermes-shim/lib/query-client'

import type { ReactNode } from 'react'

/** 语言偏好与 capabilities-pane 同源（宿主设置页的 `mirach:locale`）。
 *  插件 UI 的 `usePluginI18n(id)` 读的是上游 I18nProvider 的上下文；不挂
 *  Provider 时 locale 恒 DEFAULT_LOCALE('en')，中文界面里的插件面全是英文。 */
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

export function PluginPane({
  contributionId,
  fallback = null,
}: {
  contributionId: string
  fallback?: ReactNode
}) {
  const items = useContributions('panes')
  const item = items.find((c) => c.id === contributionId)
  // data-panel-id 是 `host.paneVisibility` 的探针面（上游按
  // `<plugin>:<pane>` 探测自己是否在屏上）。display:contents 让包装层不参与
  // 布局，窗格的尺寸/滚动仍由 dockview 管。
  return (
    <div data-panel-id={contributionId} style={{ display: 'contents' }}>
      {/* 插件 UI 普遍走 TanStack Query（花名册/例程）；宿主根没有 Provider
          （capabilities-pane / cron-pane 各自挂，同一 queryClient 单例）。 */}
      <QueryClientProvider client={queryClient}>
        {/* configClient={null}：宿主没有 hermes 的 /api/config 网关。默认
            client 会去拉 `display.language`，失败后**回落英文**（上游约定
            "拉不到就英文"），把 initialLocale 覆盖掉——插件面就全英文了。 */}
        <I18nProvider configClient={null} initialLocale={hostLocale()}>
          {item?.render ? item.render() : fallback}
        </I18nProvider>
      </QueryClientProvider>
    </div>
  )
}
