// Copy the host-boundary modules that turned out to be *pure* (no
// `window.hermesDesktop`, no store coupling) verbatim into the shim namespace.
// They are upstream code, not reimplementations — the shim directory exists only
// so the mirror has a single import target for "outside the capabilities tree".
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const DEST = 'src/hermes-shim/'

// name -> upstream path (relative to src/)
const PURE = {
  'lib/utils': 'lib/utils.ts',
  'lib/text': 'lib/text.ts',
  'lib/time': 'lib/time.ts',
  'lib/icons': 'lib/icons.ts',
  'lib/query-client': 'lib/query-client.ts',
  'lib/completion-poll': 'lib/completion-poll.ts',
  'lib/use-session-slice': 'lib/use-session-slice.ts',
  'lib/desktop-toolsets': 'lib/desktop-toolsets.ts',
  'lib/connector-tools': 'lib/connector-tools.ts',
  'lib/plugin-catalog': 'lib/plugin-catalog.ts',
  'lib/slash-completion-cache': 'lib/slash-completion-cache.ts',
  'lib/haptics': 'lib/haptics.ts',
  'lib/external-link': 'lib/external-link.tsx',
  'lib/brand-icon': 'lib/brand-icon.ts',
  'lib/keybinds/combo': 'lib/keybinds/combo.ts',
  'lib/with-timeout': 'lib/with-timeout.ts',
  'lib/storage': 'lib/storage.ts',
  'lib/persisted': 'lib/persisted.ts',
  'lib/gateway-rpc': 'lib/gateway-rpc.ts',
  'lib/gateway-liveness-policy': 'lib/gateway-liveness-policy.ts',
  'lib/identity-trace': 'lib/identity-trace.ts',
  'lib/execution-authority': 'lib/execution-authority.ts',
  'lib/long-poll': 'lib/long-poll.ts',
  'lib/stable-array': 'lib/stable-array.ts',
  'lib/profile-order': 'lib/profile-order.ts',
  'lib/layout-persistence': 'lib/layout-persistence.ts',
  'lib/platform': 'lib/platform.ts',
  'lib/connection-scoped': 'lib/connection-scoped.ts',
  'lib/chat-runtime': 'lib/chat-runtime.ts',
  'lib/session-source': 'lib/session-source.ts',
  'lib/session-timer-since': 'lib/session-timer-since.ts',
  'lib/keybinds/actions': 'lib/keybinds/actions.ts',
  'store/haptics': 'store/haptics.ts',
  'store/notify-baseline': 'store/notify-baseline.ts',
  'store/session-event-provenance': 'store/session-event-provenance.ts',
  'store/connection-registry-state': 'store/connection-registry-state.ts',
  'store/profile-remote-override': 'store/profile-remote-override.ts',
  'store/project-scope': 'store/project-scope.ts',
  'store/starmap': 'store/starmap.ts',
  'store/session-request-router': 'store/session-request-router.ts',
  'store/session-removal': 'store/session-removal.ts',
  'store/session-unread-remote': 'store/session-unread-remote.ts',
  'store/free-tier-challenge': 'store/free-tier-challenge.ts',
  'store/onboarding-presence': 'store/onboarding-presence.ts',
  'store/local-model-offer': 'store/local-model-offer.ts',
  'store/preview': 'store/preview.ts',
  'store/model-visibility': 'store/model-visibility.ts',
  'store/shared-metrics': 'store/shared-metrics.ts',
  'store/tool-view': 'store/tool-view.ts',
  'store/pull-requests': 'store/pull-requests.ts',
  'store/session-dot-state': 'store/session-dot-state.ts',
  'store/composer-status-drawer': 'store/composer-status-drawer.ts',
  'store/preview-ownership': 'store/preview-ownership.ts',
  'store/preview-status': 'store/preview-status.ts',
  'store/project-tree': 'store/project-tree.ts',
  'store/provider-wait': 'store/provider-wait.ts',
  'store/session-focus': 'store/session-focus.ts',
  'store/session-no-reply': 'store/session-no-reply.ts',
  'store/session-owner-resolution': 'store/session-owner-resolution.ts',
  'store/session-unread': 'store/session-unread.ts',
  'store/transcript-tail-cache': 'store/transcript-tail-cache.ts',
  'store/session-owner-holds': 'store/session-owner-holds.ts',
  'store/recovery-requests': 'store/recovery-requests.ts',
  'store/default-profile': 'store/default-profile.ts',
  'store/gateway-switch': 'store/gateway-switch.ts',
  'store/parked-card-answers': 'store/parked-card-answers.ts',
  'store/external-links': 'store/external-links.ts',
  'store/composer': 'store/composer.ts',
  'store/chat-text-scale': 'store/chat-text-scale.ts',
  'store/workspace-events': 'store/workspace-events.ts',
  'store/desktop-metrics': 'store/desktop-metrics.ts',
  'components/pane-shell/workspace-scope': 'components/pane-shell/workspace-scope.ts',
  'components/pane-shell': 'components/pane-shell/index.ts',
  'components/ui/setup-field-list': 'components/ui/setup-field-list.tsx',
  'app/session/hooks/use-session-actions/utils': 'app/session/hooks/use-session-actions/utils.ts',
  'app/chat/thread-loading': 'app/chat/thread-loading.ts',
  'app/types': 'app/types.ts',
  'app/routes': 'app/routes.ts',
  'api/canonical-protocol': 'api/canonical-protocol.ts'
}

const log = []
for (const [destName, src] of Object.entries(PURE)) {
  const srcPath = UP + src
  if (!existsSync(srcPath)) {
    log.push(`MISS ${src}`)
    continue
  }
  const destPath = join(DEST, destName + (src.endsWith('.tsx') ? '.tsx' : '.ts'))
  mkdirSync(dirname(destPath), { recursive: true })
  copyFileSync(srcPath, destPath)
  log.push(`OK   ${destName}`)
}
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/pure-copy.log', log.join('\n'), 'utf8')
console.log(log.filter(l => l.startsWith('MISS')).join('\n') || 'all copied')
