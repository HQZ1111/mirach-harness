// For each unresolved `@/hermes-shim/*` specifier, name the shim module that
// imports it. That tells us which adapter is dragging the desktop app in.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

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

const missing = process.argv.slice(2)
for (const rel of missing) {
  const importers = []
  for (const f of walk(SHIM)) {
    const t = readFileSync(f, 'utf8')
    if (t.includes(`@/hermes-shim/${rel}`)) importers.push(f.replace(/\\/g, '/').replace(SHIM + '/', ''))
  }
  const exists = EXTS.some(e => existsSync(join(SHIM, rel + e)))
  console.log(`${rel}  ${exists ? '(exists)' : ''} <- ${importers.join(', ')}`)
}
