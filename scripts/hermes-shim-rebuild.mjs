// Rebuild `src/hermes-shim` from scratch, deciding per module whether it can be
// copied verbatim or must be a host adapter.
//
// Rule: a boundary module is copied verbatim only when its own import closure
// stays inside the "clean" set (pure libs, i18n, the shared package, the mirror).
// The moment a module reaches the gateway state machine / chat runtime / plugin
// SDK, copying it would drag the whole desktop app in — that module gets a host
// adapter instead, written against the exact export list the mirror imports.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const SHIM = 'src/hermes-shim/'
const MIRROR = 'src/hermes-mirror/'
const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

rmSync(SHIM, { recursive: true, force: true })

// Verbatim copies: self-contained upstream modules (no gateway, no chat runtime,
// no Electron bridge). Chosen from the AST contract of the mirror's imports.
const VERBATIM = [
  // lib — pure helpers
  'lib/utils.ts',
  'lib/text.ts',
  'lib/time.ts',
  'lib/icons.ts',
  'lib/query-client.ts',
  'lib/completion-poll.ts',
  'lib/use-session-slice.ts',
  'lib/desktop-toolsets.ts',
  'lib/connector-tools.ts',
  'lib/plugin-catalog.ts',
  'lib/slash-completion-cache.ts',
  'lib/haptics.ts',
  'lib/external-link.tsx',
  'lib/brand-icon.ts',
  'lib/keybinds/combo.ts',
  'lib/keybinds/actions.ts',
  'lib/with-timeout.ts',
  'lib/storage.ts',
  'lib/persisted.ts',
  'lib/gateway-rpc.ts',
  'lib/gateway-liveness-policy.ts',
  'lib/identity-trace.ts',
  'lib/execution-authority.ts',
  'lib/long-poll.ts',
  'lib/stable-array.ts',
  'lib/profile-order.ts',
  'lib/layout-persistence.ts',
  'lib/platform.ts',
  'lib/connection-scoped.ts',
  'lib/session-source.ts',
  'lib/session-timer-since.ts',
  'lib/draft-title.ts',
  'lib/desktop-fs.ts',
  'lib/desktop-git.ts',
  'lib/embedded-images.ts',
  'lib/preview-targets.ts',
  'lib/spoken-reply.ts',
  'lib/local-gateway-ensure-failure.ts',
  'lib/gateway-ws-url.ts',
  'lib/chat-messages/index.ts',
  'lib/chat-messages/types.ts',
  'lib/chat-messages/parts.ts',
  'lib/chat-messages/tool-parts.ts',
  'lib/chat-messages/hydration.ts',
  'lib/chat-messages/reconciliation.ts',
  'lib/chat-messages/attachment-turn.ts',
  'lib/preview-annotate/group.ts',
  'lib/preview-annotate/handoff.ts',
  'lib/preview-annotate/identity.ts',
  'lib/preview-annotate/pack.ts',
  'lib/preview-annotate/stack.ts',
  'lib/preview-annotate/tokens.ts',
  'lib/legacy-session-owner-backfill.ts',
  'lib/session-owner-stamp.ts',
  'lib/wake-indicator.ts',

  // api — thin REST wrappers over the bridge (`window.hermesDesktop.api`)
  'api/client.ts',
  'api/canonical-protocol.ts',
  'api/config.ts',
  'api/cron.ts',
  'api/delegation.ts',
  'api/local-models.ts',
  'api/mcp.ts',
  'api/messaging.ts',
  'api/models.ts',
  'api/plugins.ts',
  'api/profiles.ts',
  'api/sessions.ts',
  'api/skills.ts',
  'api/system.ts',
  'api/toolsets.ts',

  // store — small, self-contained
  'store/haptics.ts',
  'store/notify-baseline.ts',
  'store/session-event-provenance.ts',
  'store/connection-registry-state.ts',
  'store/profile-remote-override.ts',
  'store/project-scope.ts',
  'store/starmap.ts',
  'store/session-request-router.ts',
  'store/session-removal.ts',
  'store/session-unread-remote.ts',
  'store/free-tier-challenge.ts',
  'store/onboarding-presence.ts',
  'store/local-model-offer.ts',
  'store/preview.ts',
  'store/model-visibility.ts',
  'store/shared-metrics.ts',
  'store/tool-view.ts',
  'store/pull-requests.ts',
  'store/session-dot-state.ts',
  'store/composer-status-drawer.ts',
  'store/preview-ownership.ts',
  'store/preview-status.ts',
  'store/project-tree.ts',
  'store/provider-wait.ts',
  'store/session-focus.ts',
  'store/session-no-reply.ts',
  'store/session-owner-resolution.ts',
  'store/session-unread.ts',
  'store/transcript-tail-cache.ts',
  'store/session-owner-holds.ts',
  'store/recovery-requests.ts',
  'store/default-profile.ts',
  'store/chat-text-scale.ts',
  'store/external-links.ts',
  'store/workspace-events.ts',
  'store/parked-card-answers.ts',
  'store/connection-request.ts',
  'store/custom-models.ts',
  'store/interface-mode.ts',
  'store/keybinds.ts',
  'store/panes.ts',
  'store/reasoning-disclosure.ts',
  'store/statusbar-prefs.ts',
  'store/tabstrip-prefs.ts',
  'store/transcript-lightbox.ts',
  'store/translucency.ts',
  'store/windows.ts',
  'store/activity.ts',
  'store/confirm.ts',
  'store/free-tier.ts',
  'store/agent-plugins.ts',
  'store/hub-actions.ts',
  'store/plugin-catalog-install.ts',
  'store/plugin-install-request.ts',
  'store/layout.ts',
  'store/session-gone-latch.ts',
  'store/connections.ts',
  'store/desktop-metrics.ts',
  'store/transcript-tail.ts',
  'store/onboarding-phase.ts',
  'store/onboarding-session.ts',
  'store/composer-status.ts',
  'store/subagents.ts',
  'store/composer.ts',
  'store/preview-explicit.ts',
  'store/clarify.ts',
  'store/goals.ts',
  'store/native-notifications.ts',
  'store/prompts.ts',
  'store/runtime-gone.ts',
  'store/server-requests.ts',
  'store/todos.ts',
  'store/artifacts.ts',
  'store/cron.ts',
  'store/dead-session-prune.ts',
  'store/live-sync.ts',
  'store/projects.ts',
  'store/reactions-local.ts',
  'store/session-control.ts',
  'store/session-pin-sync.ts',
  'store/updates.ts',
  'store/pending-submissions.ts',
  'store/onboarding.ts',
  'store/gateway-switch.ts',

  // global types (upstream's Electron surface; the host bridge satisfies it)
  'global.d.ts'
]

const log = []
for (const rel of VERBATIM) {
  const src = UP + rel
  if (!existsSync(src)) {
    log.push(`MISS ${rel}`)
    continue
  }
  const dest = SHIM + rel
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  log.push(`OK   ${rel}`)
}

writeFileSync('C:/Users/Administrator/AppData/Local/Temp/rebuild.log', log.join('\n'), 'utf8')
console.log('copied', log.filter(l => l.startsWith('OK')).length, 'missing', log.filter(l => l.startsWith('MISS')).length)
console.log(log.filter(l => l.startsWith('MISS')).join('\n'))
