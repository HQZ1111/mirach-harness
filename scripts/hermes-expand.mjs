// Expand the mirror until the only things left unresolved are genuine host
// boundaries. Rule: for every `@/hermes-shim/<rel>` specifier the mirror still
// reaches, if upstream has `src/<rel>.{ts,tsx}` (or a directory index), copy it
// into the mirror (and recurse into its own imports). What remains unresolved
// afterwards is the real shim surface — the modules that talk to the host.
//
// Deliberately NOT auto-copied (they are the boundary by definition):
//   hermes.ts          — the REST/WS client barrel
//   api/**             — REST helpers
//   store/gateway.ts, store/session.ts, store/profile.ts,
//   store/notifications.ts, store/session-states.ts, store/connections.ts
//                      — the gateway connection/registry state machines
//   contrib/**         — the plugin contribution runtime
//   sdk/**             — the plugin SDK
// Those get real host adapters under src/hermes-shim/.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const MIRROR = 'src/hermes-mirror/'
const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx', '.css']

const BOUNDARY = [
  'hermes.ts',
  'api/',
  'store/gateway.ts',
  'store/session.ts',
  'store/profile.ts',
  'store/notifications.ts',
  'store/session-states.ts',
  'store/connections.ts',
  'contrib/',
  'sdk/',
  'global.d.ts'
]

const isBoundary = rel => BOUNDARY.some(b => (b.endsWith('/') ? rel.startsWith(b) : rel === b))

// Return the resolved *path* (not the extension) — returning the extension
// silently produced `relative(UP, '')` and an absolute-looking dest.
const upResolve = rel => {
  for (const e of EXTS) {
    const p = UP + rel + e
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

function walkMirror(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walkMirror(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const copied = []
const unresolved = new Set()

for (let round = 0; round < 12; round++) {
  const pending = new Map() // rel -> importing file
  for (const file of walkMirror('src/hermes-mirror')) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/['"]@\/hermes-shim\/([^'"]+)['"]/g)) {
      const rel = m[1]
      if (!pending.has(rel)) pending.set(rel, file)
    }
  }

  let progressed = false
  unresolved.clear()
  for (const [rel, importer] of pending) {
    const upstream = upResolve(rel)
    if (!upstream) {
      unresolved.add(`${rel}  <- ${relative('src', importer).replace(/\\/g, '/')}`)
      continue
    }
    const upRel = relative(UP, upstream).replace(/\\/g, '/')
    if (isBoundary(upRel)) {
      unresolved.add(`${rel}  <- ${relative('src', importer).replace(/\\/g, '/')}  [boundary: ${upRel}]`)
      continue
    }
    const dest = MIRROR + upRel
    if (existsSync(dest)) continue
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(upstream, dest)
    copied.push(upRel)
    progressed = true
  }

  if (!progressed) break
}

writeFileSync(
  'C:/Users/Administrator/AppData/Local/Temp/expand.log',
  `copied=${copied.length}\n${copied.sort().join('\n')}\n\nunresolved=${unresolved.size}\n${[...unresolved].sort().join('\n')}`,
  'utf8'
)
console.log(`copied=${copied.length} unresolved=${unresolved.size}`)
console.log([...unresolved].sort().join('\n'))
