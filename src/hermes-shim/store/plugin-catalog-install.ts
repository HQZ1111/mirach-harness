/**
 * `@/store/plugin-catalog-install` — the catalog pick's path into the install
 * dialog, VERBATIM upstream logic.
 *
 * Upstream resolves a curated-catalog pick to the pinned install request and
 * hands it to `openPluginInstallRequest`. The host has no installer (pi's
 * extensions are manifest directories under `.pi/extensions/<id>/`, loaded at
 * session start), so `openPluginInstallRequest` records the request and the
 * dialog it would open is absent — the same "not available here" surface the
 * rest of the plugin tab uses. Keeping upstream's resolution logic (already
 * installed? → success toast, otherwise build the request) means the moment a
 * real installer lands, this file needs no rewrite.
 */

import { translateNow } from '@/hermes-mirror/i18n'
import type { PluginCatalogEntry, PluginCatalogLookupError } from '@/hermes-shim/lib/plugin-catalog'

import { $agentPlugins } from './agent-plugins'
import { notify } from './notifications'
import { openPluginInstallRequest, type PluginInstallRequest } from './plugin-install-request'

export function openCatalogPluginInstall(
  entry: PluginCatalogEntry,
  profile: null | string,
  options: Pick<PluginInstallRequest, 'stayAfterInstall' | 'tier' | 'title'> = {}
): void {
  const existing = $agentPlugins.get().find(row => row.catalog_name === entry.name || row.name === entry.name)

  if (existing && !existing.update_available) {
    notify({ kind: 'success', message: translateNow('skills.plugins.alreadyInstalled', entry.name) })

    return
  }

  openPluginInstallRequest({
    catalogName: entry.name,
    profile,
    repo: entry.subdir ? `${entry.repo}#${entry.subdir}` : entry.repo,
    sha: entry.sha,
    summary: entry.summary,
    tier: entry.tier,
    ...options
  })
}

const DEEP_LINK_ERROR_KEYS: Record<PluginCatalogLookupError, string> = {
  invalid_name: 'skills.plugins.deepLinkCatalogInvalidName',
  unavailable: 'skills.plugins.deepLinkCatalogUnavailable',
  unknown: 'skills.plugins.deepLinkCatalogUnknown'
}

/**
 * `hermes://plugin/install?catalog=<name>` — upstream resolves the name against
 * the backend's live catalog (pinned SHA + provenance). The host's catalog is
 * the awesome lists, which carry no per-name pin, and there is no deep-link
 * handler installed (no `hermes://` protocol registration), so this REJECTS
 * with the reason instead of resolving to a made-up repo.
 */
export async function requestPluginCatalogInstallFromDeepLink(name: string): Promise<void> {
  throw new Error(
    `插件目录深链「${name}」在本宿主不可用：目录源是 awesome 列表（无逐名 pin），且没有注册 hermes:// 协议处理器`
  )
}

/** Kept so the error-key table above stays referenced by upstream's own copy. */
export const DEEP_LINK_ERROR_KEYS_FOR_TESTS = DEEP_LINK_ERROR_KEYS
