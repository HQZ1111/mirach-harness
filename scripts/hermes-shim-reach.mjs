// Per-module reach inside the shim tree. Any shim module whose reach is large
// is pulling the desktop app in (chat runtime, session state machine, plugin
// SDK) — those must be hand-written adapters instead of verbatim copies.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

const SHIM = 'src/hermes-shim'
const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

function walk(dir, acc = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(n)) acc.push(p)
  }
  return acc
}

const resolve = (base) => {
  for (const e of EXTS) {
    const p = base + e
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

function reachOf(entry) {
  const seen = new Set()
  const stack = [entry]
  while (stack.length) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(/(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1]
      let next = null
      if (spec.startsWith('.')) next = resolve(normalize(join(dirname(file), spec)))
      else if (spec.startsWith('@/hermes-shim/')) next = resolve(join(SHIM, spec.slice(14)))
      else if (spec.startsWith('@/hermes-mirror/')) next = resolve('src/hermes-mirror/' + spec.slice(16))
      else if (spec.startsWith('@/')) next = resolve(UP + spec.slice(2))
      if (next) stack.push(next)
    }
  }
  return seen.size
}

const rows = walk(SHIM).map(f => ({ f: f.replace(/\\/g, '/').replace(SHIM + '/', ''), reach: reachOf(f) }))
rows.sort((a, b) => b.reach - a.reach)
for (const r of rows) console.log(String(r.reach).padStart(5), r.f)
