// Prune shim modules that nothing reachable imports any more.
//
// The shim started as verbatim copies of upstream store/lib modules; once the
// heavy ones (gateway/session/profile/desktop-metrics/…) became small adapters,
// their old dependency chains (chat-messages, preview, pull-requests, the
// assistant-ui directive components) are dead weight that still gets type-checked.
// A file is pruned when no *other* shim file and no mirror file imports it.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const SHIM = 'src/hermes-shim'
const MIRROR = 'src/hermes-mirror'
const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

// Never prune: the boundary modules the mirror imports (the 55), the entry
// points, and anything with a host adapter's rationale in it.
const KEEP = new Set([
  'hermes.ts',
  'react-router.ts',
  'global.ts',
  'bridge.ts',
  'routes.ts',
  'api/client.ts',
  'api/mcp.ts',
  'api/toolsets.ts',
  'api/canonical-protocol.ts',
  'store/agent-plugins.ts',
  'store/activity.ts',
  'store/confirm.ts',
  'store/connection-request.ts',
  'store/connections.ts',
  'store/custom-models.ts',
  'store/desktop-metrics.ts',
  'store/free-tier.ts',
  'store/free-tier-sign-in.ts',
  'store/gateway.ts',
  'store/hub-actions.ts',
  'store/interface-mode.ts',
  'store/keybinds.ts',
  'store/layout.ts',
  'store/notifications.ts',
  'store/panes.ts',
  'store/plugin-catalog-install.ts',
  'store/plugin-install-request.ts',
  'store/profile.ts',
  'store/reasoning-disclosure.ts',
  'store/session-gone-latch.ts',
  'store/session-states.ts',
  'store/session.ts',
  'store/statusbar-prefs.ts',
  'store/tabstrip-prefs.ts',
  'store/transcript-lightbox.ts',
  'store/translucency.ts',
  'store/windows.ts',
  'contrib/registry.ts',
  'contrib/types.ts',
  'contrib/plugins-store.ts',
  'contrib/react/boundary.tsx',
  'contrib/react/use-contributions.ts',
  'contrib/runtime-loader.ts',
  'contrib/settings-pages.ts',
  'app-gateway/hooks/use-gateway-request.ts',
  // lib modules the mirror imports
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
  'lib/haptics.ts',
  'lib/external-link.tsx',
  'lib/brand-icon.ts',
  'lib/keybinds/combo.ts',
  'lib/with-timeout.ts',
  'lib/storage.ts',
  'lib/persisted.ts',
  'lib/gateway-rpc.ts',
  'store/haptics.ts',
  'store/external-links.ts'
])

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const resolveIn = (root, rel) => EXTS.map(e => rel + e).find(cand => existsSync(join(root, cand)))

function importedPaths(file) {
  const text = readFileSync(file, 'utf8')
  const specs = [
    ...[...text.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)].map(m => m[1]),
    ...[...text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map(m => m[1]),
    ...[...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1])
  ]
  const out = []
  for (const spec of specs) {
    if (spec.startsWith('@/hermes-shim/')) {
      const rel = resolveIn(SHIM, spec.slice(14))
      if (rel) out.push(rel)
    } else if (spec.startsWith('@/hermes-mirror/')) {
      // mirror targets are never pruned targets
    } else if (spec.startsWith('.')) {
      const abs = join(dirname(file), spec)
      const rel = relative(SHIM, abs).replace(/\\/g, '/')
      const relResolved = resolveIn(SHIM, rel)
      if (relResolved) out.push(relResolved)
    }
  }
  return out
}

// eslint-disable-next-line no-undef
const dirname = (await import('node:path')).dirname

let pruned = 0
for (let round = 0; round < 10; round++) {
  const files = walk(SHIM)
  const importers = new Map()
  for (const file of files) {
    for (const target of importedPaths(file)) {
      const list = importers.get(target) ?? []
      list.push(relative(SHIM, file).replace(/\\/g, '/'))
      importers.set(target, list)
    }
  }

  const doomed = []
  for (const file of files) {
    const rel = relative(SHIM, file).replace(/\\/g, '/')
    if (KEEP.has(rel)) continue
    // Prune only when NOTHING imports it — a KEEP file importing it still makes
    // it live (that was the bug in the first cut: excluding KEEP importers
    // pruned modules the boundary itself depends on).
    const used = importers.get(rel) ?? []
    if (used.length === 0) doomed.push(file)
  }

  if (doomed.length === 0) break

  for (const file of doomed) {
    rmSync(file, { force: true })
    pruned++
  }
}

console.log('pruned', pruned)
