// Which shim modules does the capabilities page actually reach?
// Walks the mirror from the page entry, stops at shim modules, then resolves
// each shim module's own deps (one level, and transitively) so we know the real
// adapter surface instead of the whole upstream app's.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

const MIRROR = 'src/hermes-mirror'
const SHIM = 'src/hermes-shim'
const ENTRY = join(MIRROR, 'app/capabilities/index.tsx')

const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
const resolveBase = base => EXTS.find(e => existsSync(base + e))

function resolveSpec(spec, fromFile) {
  if (spec.startsWith('@/hermes-mirror/')) return resolveBase(join(MIRROR, spec.slice(16)))
  if (spec.startsWith('@/hermes-shim/')) return resolveBase(join(SHIM, spec.slice(14)))
  if (spec.startsWith('.')) return resolveBase(normalize(join(dirname(fromFile), spec)))
  return null
}

const specsOf = text => {
  const out = []
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  for (const m of text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) out.push(m[1])
  return out
}

const seen = new Set()
const shims = new Map() // shim path -> Set(importer)
const queue = [ENTRY]
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
  for (const spec of specsOf(text)) {
    if (spec.startsWith('@/hermes-shim/')) {
      const rel = spec.slice(14)
      const set = shims.get(rel) ?? new Set()
      set.add(file.replace(/\\/g, '/').replace(MIRROR + '/', ''))
      shims.set(rel, set)
      const p = resolveBase(join(SHIM, rel))
      if (p) queue.push(p) // walk into it too: its own deps are ours as well
      continue
    }
    const next = resolveSpec(spec, file)
    if (next) queue.push(next)
  }
}

const norm = p => p.replace(/\\/g, '/')
const mirrorCount = [...seen].filter(f => norm(f).includes(MIRROR)).length
const shimCount = [...seen].filter(f => norm(f).includes(SHIM)).length
console.log(`mirror files reached = ${mirrorCount}`)
console.log(`shim files reached   = ${shimCount}`)
console.log('\n--- shim modules reached (from the capabilities page) ---')
for (const [p, importers] of [...shims].sort()) {
  console.log(`${p}   <- ${[...importers].join(', ')}`)
}
