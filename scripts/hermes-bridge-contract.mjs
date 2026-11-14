// Enumerate every `window.hermesDesktop.X` member the reachable graph touches,
// plus every REST `path:` string it requests. This is the exact contract the
// host bridge must satisfy — anything else in upstream's global.d.ts is dead
// weight for this page.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOTS = ['src/hermes-mirror', 'src/hermes-shim']
const out = process.argv[2]

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const members = new Map()
const paths = new Map()

for (const root of ROOTS) {
  if (!existsSync(root)) continue
  for (const file of walk(root)) {
    const text = readFileSync(file, 'utf8')
    const rel = file.replace(/\\/g, '/')
    // window.hermesDesktop?.foo / window.hermesDesktop.foo / destructured use
    for (const m of text.matchAll(/window\.hermesDesktop\??\.([A-Za-z_$][\w$]*)/g)) {
      const set = members.get(m[1]) ?? new Set()
      set.add(rel)
      members.set(m[1], set)
    }
    for (const m of text.matchAll(/path:\s*[`'"]([^`'"]+)[`'"]/g)) {
      // Normalize `${encodeURIComponent(x)}` → `:param` so routes collapse.
      const route = m[1].replace(/\$\{[^}]*\}/g, ':p').replace(/\?.*$/, '')
      const set = paths.get(route) ?? new Set()
      set.add(rel)
      paths.set(route, set)
    }
  }
}

let s = '--- window.hermesDesktop members ---\n'
for (const [k, files] of [...members].sort()) s += `${k}   (${files.size} files)\n`
s += '\n--- requested REST paths ---\n'
for (const [k, files] of [...paths].sort()) s += `${k}   (${files.size})\n`
writeFileSync(out, s, 'utf8')
console.log(s)
