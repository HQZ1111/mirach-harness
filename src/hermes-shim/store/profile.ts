/**
 * `@/store/profile` shim — the profile registry.
 *
 * Upstream: named config islands (~/.hermes/profiles/<name>), each with its own
 * skills/toolsets/MCP config, switchable at runtime, plus per-profile theme and
 * remote-override state.
 *
 * Host: pi has exactly one global agent dir (~/.pi/agent) and no profile concept.
 * The capabilities page reads this store for two things only — the active profile
 * key (to scope query caches) and a normalized key for display. Both collapse to
 * a single constant here, which is the truth: there is one profile, and a scope
 * selector offering more would be inventing one.
 */

import { atom } from 'nanostores'

/** The one profile this host has. `null` = "no explicit scope", which every
 *  scoped query in the capabilities tree treats as the ambient profile. */
export const $activeGatewayProfile = atom<null>(null)

export type AgentProfileRoute = string

/** Upstream normalizes profile names for cache keys; with one profile the key is
 *  a constant, but the signature is kept (call sites pass `null`, strings and
 *  objects). */
export function normalizeProfileKey(profile?: null | string | { profile?: null | string }): string {
  if (profile && typeof profile === 'object') {
    return (profile.profile ?? '').trim() || 'default'
  }
  return (profile ?? '').trim() || 'default'
}

/**
 * 侧栏/页面用的 profile 作用域（上游 `store/profile.ts` 的同名 atom）。
 *
 * 上游的取值是具体 profile 名或 `ALL_PROFILES`（跨 profile 聚合视图）。
 * 宿主只有一份配置，所以恒为 `'default'`——**不是** `ALL_PROFILES`：
 * 镜像来的 `cron/index.tsx:369` 会把它喂给 `cronProfileForScope()`，
 * 而 `'all'` 在宿主 API 里没有对应语义（宿主 API 忽略 profile 参数）。
 * 给 `'default'` 让作用域键稳定，查询缓存不会因每次渲染重建。
 */
export const $profileScope = atom<string>('default')

/** 上游「全部 profile」的哨兵值。宿主的 `$profileScope` 永不为它，
 *  但镜像来的比较表达式需要这个常量存在（否则 tsc 报未导出）。 */
export const ALL_PROFILES = 'all'
