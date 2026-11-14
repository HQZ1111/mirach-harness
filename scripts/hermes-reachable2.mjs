// Reachable shim modules from the capabilities page, walking THROUGH shim
// modules (their own imports are part of the page's runtime graph).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

const MIRROR = 'src/hermes-mirror'
const SHIM = 'src/hermes-shim'
const ENTRY = join(MIRROR, 'app/capabilities/index.tsx')
const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

const resolveBase = base => {
  for (const e of EXTS) {
    const p = base + e
    if (existsSync(p)) return p
  }
  return null
}

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
    const next = resolveSpec(spec, file)
    if (next) queue.push(next)
  }
}

const norm = p => p.replace(/\\/g, '/')
const mirror = [...seen].filter(f => norm(f).includes(MIRROR)).sort()
const shim = [...seen].filter(f => norm(f).includes(SHIM)).sort()

const lines = [
  `mirror reachable = ${mirror.length}`,
  `shim reachable   = ${shim.length}`,
  '',
  '--- shim modules on the page\'s runtime graph ---',
  ...shim.map(f => '  ' + norm(f).replace(SHIM + '/', ''))
]
writeFileSync(process.argv[2], lines.join('\n'), 'utf8')
console.log(lines.slice(0, 2).join('\n'))
