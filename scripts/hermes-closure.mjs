// Transitive import closure over upstream hermes `apps/desktop/src` so we know
// exactly which files the capabilities copy needs (and where the gateway
// boundary is). Prints files grouped by top-level area, and every specifier
// that leaves the tree.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve } from 'node:path'

const SRC = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src'
const SHARED = 'D:/新建文件夹 (5)/hermes-agent-main/apps/shared/src'

const roots = process.argv.slice(2)
const seen = new Set()
const external = new Map()
const outside = new Set()

const exts = ['.ts', '.tsx', '/index.ts', '/index.tsx']

function resolveSpecifier(spec, fromFile) {
  if (spec.startsWith('@/')) {
    return tryResolve(join(SRC, spec.slice(2)))
  }
  if (spec === '@hermes/shared') {
    outside.add(SHARED + '/index.ts')
    return SHARED + '/index.ts'
  }
  if (spec.startsWith('@hermes/shared/')) {
    const p = SHARED + '/' + spec.slice('@hermes/shared/'.length) + '.ts'
    outside.add(p)
    return p
  }
  if (spec.startsWith('.')) {
    return tryResolve(normalize(join(dirname(fromFile), spec)))
  }
  const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
  external.set(pkg, (external.get(pkg) ?? 0) + 1)
  return null
}

function tryResolve(base) {
  if (existsSync(base) && statSync(base).isFile()) return base
  for (const e of exts) {
    if (existsSync(base + e)) return base + e
  }
  return null
}

const queue = [...roots]
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
  for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)) {
    const next = resolveSpecifier(m[1], file)
    if (next) queue.push(next)
  }
  for (const m of text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const next = resolveSpecifier(m[1], file)
    if (next) queue.push(next)
  }
}

const byArea = new Map()
for (const f of seen) {
  const rel = relative(SRC, f).replace(/\\/g, '/')
  const area = rel.startsWith('..') ? 'SHARED' : rel.split('/').slice(0, 2).join('/')
  const list = byArea.get(area) ?? []
  list.push(rel)
  byArea.set(area, list)
}

let out = `files=${seen.size}\n`
for (const [area, list] of [...byArea].sort((a, b) => b[1].length - a[1].length)) {
  out += `\n[${area}] ${list.length}\n`
  for (const f of list.sort()) out += `  ${f}\n`
}
out += `\n--- external packages ---\n`
for (const [k, v] of [...external].sort((a, b) => b[1] - a[1])) out += `${v}\t${k}\n`
console.log(out)
