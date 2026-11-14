// Rewrite module specifiers inside the mirrored tree (`src/hermes-mirror`) and
// the shim tree (`src/hermes-shim`) so both resolve inside the host.
//
// Routing is decided by *what actually exists*, not by a hand-maintained list:
//   - the mirror wins when it has the file  → `@/hermes-mirror/…`
//   - otherwise the shim                     → `@/hermes-shim/…`
// That way copying one more upstream file never requires editing this script.
//
// Shim modules themselves are *upstream code* too (pure libs, stores), so they
// get the same treatment: their `@/…` imports are remapped the same way.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'

const MIRROR = 'src/hermes-mirror'
const SHIM = 'src/hermes-shim'
const MIRROR_ALIAS = '@/hermes-mirror'
const SHIM_ALIAS = '@/hermes-shim'
const dryRun = process.argv.includes('--dry-run')

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx|css)$/.test(name)) acc.push(p)
  }
  return acc
}

const EXTS = ['', '.ts', '.tsx', '.css', '/index.ts', '/index.tsx']
const inMirror = rel => EXTS.some(e => existsSync(join(MIRROR, rel + e)))
const inShim = rel => EXTS.some(e => existsSync(join(SHIM, rel + e)))
// The host's own modules: a shim that needs `@/lib/ipc` or `@/lib/tauri-window`
// should import the real one, not get a private copy (one IPC wrapper per app).
const inHost = rel => EXTS.some(e => existsSync(join('src', rel + e)))

function targetOf(spec) {
  // Idempotence: already-rewritten specifiers must not be rewritten again.
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
  if (t.force === 'mirror' || (!t.force && inMirror(t.path))) return `${MIRROR_ALIAS}/${t.path}`
  if (t.force === 'shim' || inShim(t.path)) return `${SHIM_ALIAS}/${t.path}`
  if (inHost(t.path)) return `@/${t.path}`
  // Nothing exists yet: default to the shim so tsc reports the missing module
  // as a named gap instead of silently resolving to the host's own file.
  return `${SHIM_ALIAS}/${t.path}`
}

const stats = { mirror: 0, shim: 0 }
const unresolved = new Set()
let changed = 0

// Rewrite ONLY import specifiers, not every quoted string. The first version of
// this script replaced any quoted token — which silently corrupted string
// literals and comments ('git' → '@/hermes-shim/git'), changing runtime
// behaviour while typechecking fine. The AST keeps the edit surgical.
function rewriteSpecifiers(text, onSpec) {
  const sf = ts.createSourceFile('x.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let out = text
  const spans = []
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier)) {
      const spec = node.moduleSpecifier
      if (spec && ts.isStringLiteral(spec)) spans.push({ start: spec.getStart(sf), end: spec.getEnd(), text: spec.text })
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  // Apply right-to-left so offsets stay valid.
  spans.sort((a, b) => b.start - a.start)
  for (const span of spans) {
    const to = onSpec(span.text)
    if (to === null || to === span.text) continue
    out = out.slice(0, span.start) + `'${to}'` + out.slice(span.end)
  }
  return { out, count: spans.length }
}

for (const root of [MIRROR, SHIM]) {
  for (const file of walk(root)) {
    if (!/\.(ts|tsx)$/.test(file)) continue
    const text = readFileSync(file, 'utf8')
    let fileChanged = false
    const { out } = rewriteSpecifiers(text, spec => {
      const to = resolve(spec)
      if (!to) return null
      if (to.startsWith(MIRROR_ALIAS)) stats.mirror++
      else {
        stats.shim++
        const rel = to.slice(SHIM_ALIAS.length + 1)
        if (!inShim(rel)) unresolved.add(rel)
      }
      if (to !== spec) fileChanged = true
      return to
    })
    if (fileChanged && out !== text) {
      changed++
      if (!dryRun) writeFileSync(file, out, 'utf8')
    }
  }
}

console.log(`changed=${changed} ->mirror=${stats.mirror} ->shim=${stats.shim}`)
console.log('\n--- still-missing shim modules ---')
console.log([...unresolved].sort().join('\n'))
