// Prune shim modules unreachable from the boundary set the mirror actually
// imports. Walks only KEEP files + their transitive shim deps; anything else is
// dead weight that still gets type-checked.
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const SHIM = 'src/hermes-shim'
const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

const KEEP = [
  'hermes.ts',
  'bridge.ts',
  'routes.ts',
  'react-router.ts',
  'global.ts',
  'api/client.ts',
  'api/mcp.ts',
  'api/toolsets.ts',
  'api/canonical-protocol.ts',
  'app-gateway/hooks/use-gateway-request.ts',
  'contrib/registry.ts',
  'contrib/types.ts',
  'contrib/plugins-store.ts',
  'contrib/react/boundary.tsx',
  'contrib/react/use-contributions.ts',
  'contrib/runtime-loader.ts',
  'contrib/settings-pages.ts',
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
  'store/agent-plugins.ts',
  'store/activity.ts',
  'store/confirm.ts',
  'store/connection-request.ts',
  'store/connections.ts',
  'store/custom-models.ts',
  'store/desktop-metrics.ts',
  'store/external-links.ts',
  'store/free-tier.ts',
  'store/free-tier-sign-in.ts',
  'store/gateway.ts',
  'store/haptics.ts',
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
  'store/windows.ts'
]

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const resolveIn = rel => EXTS.map(e => rel + e).find(cand => existsSync(join(SHIM, cand)))

function importedRel(file) {
  const text = readFileSync(file, 'utf8')
  const specs = [
    ...[...text.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)].map(m => m[1]),
    ...[...text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map(m => m[1]),
    ...[...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1])
  ]
  const out = []
  for (const spec of specs) {
    let rel = null
    if (spec.startsWith('@/hermes-shim/')) rel = spec.slice(14)
    else if (spec.startsWith('.')) rel = relative(SHIM, join(dirname(file), spec)).replace(/\\/g, '/')
    if (rel === null) continue
    const resolved = resolveIn(rel)
    if (resolved) out.push(resolved)
  }
  return out
}

const files = walk(SHIM)
const relOf = new Map(files.map(f => [f, relative(SHIM, f).replace(/\\/g, '/')]))

const keep = new Set()
const queue = KEEP.map(rel => join(SHIM, rel)).filter(f => existsSync(f))
while (queue.length) {
  const file = queue.pop()
  if (!file || keep.has(file)) continue
  keep.add(file)
  for (const rel of importedRel(file)) {
    const target = join(SHIM, rel)
    if (existsSync(target) && statSync(target).isFile() && !keep.has(target)) queue.push(target)
  }
}

let pruned = 0
for (const file of files) {
  if (keep.has(file)) continue
  rmSync(file, { force: true })
  pruned++
}
console.log('keep =', keep.size, '| pruned =', pruned)
