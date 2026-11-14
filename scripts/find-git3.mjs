// Instrument: which specifier resolves to the shim module 'git'?
import ts from 'typescript'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIRROR = 'src/hermes-mirror'
const SHIM = 'src/hermes-shim'
const MIRROR_ALIAS = '@/hermes-mirror'
const SHIM_ALIAS = '@/hermes-shim'
const EXTS = ['', '.ts', '.tsx', '.css', '/index.ts', '/index.tsx']
const inMirror = rel => EXTS.some(e => exists(join(MIRROR, rel + e)))
const inShim = rel => EXTS.some(e => exists(join(SHIM, rel + e)))
const inHost = rel => EXTS.some(e => exists(join('src', rel + e)))

import { existsSync } from 'node:fs'
function exists(p) {
  return existsSync(p)
}

function targetOf(spec) {
  if (spec.startsWith(MIRROR_ALIAS) || spec.startsWith(SHIM_ALIAS)) return null
  if (spec === '@hermes/shared') return { path: 'shared', force: 'mirror' }
  if (spec.startsWith('@hermes/shared/')) return { path: `shared/${spec.slice(15)}`, force: 'mirror' }
  if (spec.startsWith('@/')) return { path: spec.slice(2) }
  if (spec === 'react-router') return { path: 'react-router', force: 'shim' }
  return null
}

function resolve(spec) {
  const t = targetOf(spec)
  if (!t) return null
  if (t.force === 'mirror' || (!t.force && inMirror(t.path))) return `@/hermes-mirror/${t.path}`
  if (t.force === 'shim' || inShim(t.path)) return `@/hermes-shim/${t.path}`
  if (inHost(t.path)) return `@/${t.path}`
  return `@/hermes-shim/${t.path}`
}

function walk(d, acc = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(n)) acc.push(p)
  }
  return acc
}

const hits = []
for (const f of [...walk(MIRROR), ...walk(SHIM)]) {
  const text = readFileSync(f, 'utf8')
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const to = resolve(node.moduleSpecifier.text)
      if (to === '@/hermes-shim/git') {
        hits.push(`${f.replace(/\\/g, '/')} imports '${node.moduleSpecifier.text}'`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/githits.txt', hits.join('\n') || '(none)', 'utf8')
console.log(hits.join('\n') || '(none)')
