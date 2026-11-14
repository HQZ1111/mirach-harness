// Rebuild `src/hermes-shim` as a deliberate host boundary.
//
// Only modules that are genuinely pure get copied verbatim (they are upstream
// code with no host coupling). Everything else is a hand-written adapter in
// `src/hermes-shim/` — see each file's header for what it maps to.
import { copyFileSync, existsSync, mkdirSync , writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const SHIM = 'src/hermes-shim/'

// Pure upstream modules: no gateway, no chat runtime, no Electron bridge.
// Verified by `hermes-shim-reach.mjs` (reach = 1: they import nothing of ours).
//
// NOTE: this copy is additive on purpose. The hand-written adapters in this tree
// (hermes.ts, store/gateway.ts, …) are the host boundary — deleting them to
// "rebuild" would wipe the actual work. `hermes-shim-prune.mjs` is what removes
// dead files, and it is KEEP-list aware.
const VERBATIM = [
  'lib/utils.ts',
  'lib/text.ts',
  'lib/time.ts',
  'lib/icons.ts',
  'lib/query-client.ts',
  'lib/completion-poll.ts',
  'lib/use-session-slice.ts',
  'lib/desktop-toolsets.ts',
  'lib/storage.ts',
  'lib/persisted.ts',
  'lib/platform.ts',
  'lib/stable-array.ts',
  'lib/profile-order.ts',
  'lib/session-timer-since.ts',
  'lib/long-poll.ts',
  'lib/with-timeout.ts',
  'lib/keybinds/combo.ts',
  'lib/keybinds/actions.ts',
  'lib/execution-authority.ts',
  'lib/gateway-liveness-policy.ts',
  'lib/identity-trace.ts',
  'lib/preview-targets.ts',
  'lib/preview-annotate/identity.ts',
  'lib/preview-annotate/tokens.ts',
  'lib/preview-annotate/group.ts',
  'lib/preview-annotate/pack.ts',
  'lib/preview-annotate/stack.ts',
  'lib/markdown-code.ts',
  'lib/lru-cache.ts',
  'lib/pool.ts',
  'lib/path-compare.ts',
  'lib/image-resize.ts',
  'lib/keyed-timeouts.ts',
  'lib/todos.ts',
  'lib/provider-setup-errors.ts',
  'lib/runtime-readiness.ts',
  'lib/hermes-open-target.ts',
  'lib/embedded-images.ts',
  'lib/spoken-reply.ts',
  'lib/session-refs.ts',
  'lib/session-link-title.ts',
  'lib/session-signatures.ts',
  'lib/session-source.ts',
  'lib/artifact-detect.ts',
  'lib/generated-images.ts',
  'lib/media.ts',
  'lib/draft-title.ts',
  'lib/desktop-fs.ts',
  'lib/desktop-git.ts',
  'lib/desktop-slash-commands.ts',
  'lib/connection-scoped.ts',
  'lib/layout-persistence.ts',
  'lib/gateway-rpc.ts',
  'lib/gateway-ws-url.ts',
  'lib/local-gateway-ensure-failure.ts',
  'lib/session-owner-stamp.ts',
  'lib/legacy-session-owner-backfill.ts',
  'lib/wake-indicator.ts',
  'lib/chat-messages/index.ts',
  'lib/chat-messages/types.ts',
  'lib/chat-messages/parts.ts',
  'lib/chat-messages/tool-parts.ts',
  'lib/chat-messages/hydration.ts',
  'lib/chat-messages/reconciliation.ts',
  'lib/chat-messages/attachment-turn.ts',
  'lib/preview-annotate/handoff.ts',
  'api/canonical-protocol.ts',
  'store/haptics.ts',
  'store/notify-baseline.ts',
  'store/session-event-provenance.ts',
  'store/connection-registry-state.ts',
  'store/project-scope.ts',
  'store/starmap.ts',
  'store/session-removal.ts',
  'store/free-tier-challenge.ts',
  'store/local-model-offer.ts',
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
  'store/session-owner-resolution.ts',
  'store/recovery-requests.ts',
  'store/default-profile.ts',
  'store/chat-text-scale.ts',
  'store/external-links.ts',
  'store/workspace-events.ts',
  'store/onboarding-phase.ts',
  'store/subagents.ts',
  'store/confirm.ts',
  'store/reasoning-disclosure.ts',
  'store/tabstrip-prefs.ts',
  'store/translucency.ts',
  'store/keybinds.ts',
  'store/plugin-install-request.ts',
  'store/desktop-metrics.ts',
  'store/session-removal.ts',
  'store/transcript-tail.ts'
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
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/shim-verbatim.log', log.join('\n'), 'utf8')
console.log('verbatim', log.filter(l => l.startsWith('OK')).length, 'missing', log.filter(l => l.startsWith('MISS')).length)
console.log(log.filter(l => l.startsWith('MISS')).join('\n'))
