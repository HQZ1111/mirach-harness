// Compute the *verbatim copy set* for the hermes capabilities mirror: the
// transitive import closure of `app/capabilities/index.tsx` in the upstream
// desktop app, pruned at the host boundary (everything the host must provide a
// real implementation for: gateway REST client, hermes stores, i18n runtime,
// shared types). Files that remain are pure UI/logic and get copied byte for
// byte — that is what makes the page identical instead of a look-alike.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'

const SRC = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src'
const SHARED = 'D:/新建文件夹 (5)/hermes-agent-main/apps/shared/src'

const ROOTS = ['app/capabilities/index.tsx'].map(r => join(SRC, r))

// Host boundary: these specifiers are NOT followed. A host adapter with the
// same export names lives at the same mirrored path.
const BOUNDARY = [
  '@/hermes',
  '@/global',
  '@/types/hermes',
  '@/i18n',
  '@/i18n/types',
  '@/api/',
  '@/store/',
  '@/contrib/',
  '@/sdk/',
  '@/app/gateway/',
  '@/app/routes',
  '@/app/open-session',
  '@/app/types',
  '@/app/layout-constants',
  '@/lib/mcp-',
  '@/lib/gateway-rpc',
  '@/lib/plugin-catalog',
  '@/lib/slash-completion-cache',
  '@/lib/use-session-slice',
  '@/lib/completion-poll',
  '@/lib/desktop-toolsets',
  '@/lib/connector-tools',
  '@/lib/storage',
  '@/lib/persisted',
  '@/lib/query-client',
  '@/lib/haptics',
  '@/lib/external-link',
  '@/lib/icons',
  '@/lib/text',
  '@/lib/time',
  '@/lib/utils',
  '@/lib/plugin-source-urls',
  'react-router',
  '@hermes/shared'
]

const isBoundary = spec => BOUNDARY.some(b => (b.endsWith('/') ? spec.startsWith(b) : spec === b))

const exts = ['.ts', '.tsx', '/index.ts', '/index.tsx']
function tryResolve(base) {
  if (existsSync(base) && statSync(base).isFile()) return base
  for (const e of exts) if (existsSync(base + e)) return base + e
  return null
}

const seen = new Set()
const boundaries = new Map() // specifier -> count
const external = new Map()
const unresolved = new Set()

const queue = [...ROOTS]
while (queue.length) {
  const file = queue.pop()
  if (!file || seen.has(file)) continue
  seen.add(file)
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  const specs = []
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) specs.push(m[1])
  for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1])
  // Side-effect imports (`import './page.css'`) — these are stylesheets, and
  // skipping them silently drops the page's layout.
  for (const m of text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) specs.push(m[1])
  for (const spec of specs) {
    if (isBoundary(spec)) {
      boundaries.set(spec, (boundaries.get(spec) ?? 0) + 1)
      continue
    }
    let next = null
    if (spec.startsWith('@/')) next = tryResolve(join(SRC, spec.slice(2)))
    else if (spec.startsWith('.')) next = tryResolve(normalize(join(dirname(file), spec)))
    else {
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
      external.set(pkg, (external.get(pkg) ?? 0) + 1)
      continue
    }
    if (next) queue.push(next)
    else unresolved.add(`${relative(SRC, file).replace(/\\/g, '/')} -> ${spec}`)
  }
}

const rels = [...seen].map(f => relative(SRC, f).replace(/\\/g, '/')).sort()
let out = `verbatim files = ${rels.length}\n`
for (const r of rels) out += `  ${r}\n`
out += `\n--- boundary specifiers (host adapters needed) ---\n`
for (const [k, v] of [...boundaries].sort((a, b) => b[1] - a[1])) out += `${String(v).padStart(4)}  ${k}\n`
out += `\n--- unresolved (would be copied but missing upstream) ---\n`
for (const u of [...unresolved].sort()) out += `  ${u}\n`
out += `\n--- external packages ---\n`
for (const [k, v] of [...external].sort((a, b) => b[1] - a[1])) out += `${String(v).padStart(4)}  ${k}\n`
console.log(out)
