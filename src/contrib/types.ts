/**
 * 宿主插件贡献模型——hermes `contrib/types.ts:25-51` 的最小复刻
 * （2026-11-07，"多环境配置 + pi pkg 做成插件"的载体）。
 *
 * hermes 的插件把功能拆成**贡献**（Contribution）：每个贡献有 id（插件内
 * 唯一）+ area（归属区，如设置页/侧栏/状态栏）+ render/data。宿主首批
 * 只落两个区：`settings.page`（设置页导航项）与 `bots.roster.grouping`
 * （机器人花名册按连接分组的数据贡献）——按需再扩。
 */

import type { ReactNode } from 'react'

/** 贡献来源（core = 宿主自带；否则 = 插件 id——hermes ContributionSource）。 */
export type ContributionSource = 'core' | (string & {})

/** 贡献区 id。宿主首批两区；新增区在此扩。 */
export type ContributionArea = 'settings.page' | 'bots.roster.grouping'

/** 插件贡献（hermes Contribution 同形）。 */
export interface Contribution {
  /** 插件内唯一；重注册 = 替换。 */
  id: string
  area: ContributionArea
  source?: ContributionSource
  title?: string
  order?: number
  /** UI 贡献（settings.page 用）。 */
  render?: () => ReactNode
  /** 数据贡献（bots.roster.grouping 用：按连接分组的数据面）。 */
  data?: unknown
}

/** 插件（hermes HermesPlugin:181-194 同形）。 */
export interface HarnessPlugin {
  /** 稳定 slug——贡献 id 自动加 `plugin:<id>:` 前缀。 */
  id: string
  name?: string
  description?: string
  register: (ctx: PluginContext) => void
}

/** 插件上下文（hermes PluginContext 的最小子集：register/storage/onDispose）。 */
export interface PluginContext {
  register: (contribution: Contribution) => () => void
  /** localStorage `mirach.plugin.<id>.<key>`（hermes ctx.storage 同键法）。 */
  storage: {
    get: (key: string) => null | string
    set: (key: string, value: string) => void
    remove: (key: string) => void
  }
  onDispose: (fn: () => void) => void
}
