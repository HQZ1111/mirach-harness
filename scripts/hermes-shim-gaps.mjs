// Which `@/hermes-shim/*` specifiers used by the mirror have no file yet?
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MIRROR = 'src/hermes-mirror'
const SHIM = 'src/hermes-shim'
const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const specs = new Map()
for (const f of walk(MIRROR)) {
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(/(?:import|export)[\s\S]*?from\s*['"](@\/hermes-shim\/[^'"]+)['"]/g)) {
    const rel = m[1].slice('@/hermes-shim/'.length)
    specs.set(rel, (specs.get(rel) ?? 0) + 1)
  }
}

const missing = []
const present = []
for (const [rel, n] of specs) {
  const ok = EXTS.some(e => existsSync(join(SHIM, rel + e)))
  ;(ok ? present : missing).push([rel, n])
}

console.log(`shim specifiers=${specs.size} present=${present.length} missing=${missing.length}`)
console.log('\n--- missing (need a file) ---')
for (const [rel, n] of missing.sort((a, b) => b[1] - a[1])) console.log(`${String(n).padStart(3)}  ${rel}`)
