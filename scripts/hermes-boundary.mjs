// Definitive boundary contract for the capabilities page.
//
// Walks ONLY the mirror (upstream UI code, self-contained), collecting every
// `@/hermes-shim/*` specifier plus the exact names imported from it. Then, for
// each of those specifiers, reports how many *other* shim modules it would drag
// in if copied verbatim — which is what decides adapter vs verbatim copy.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'
import ts from 'typescript'

const MIRROR = 'src/hermes-mirror'
const SHIM = 'src/hermes-shim'
const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const names = new Map() // shim rel -> Map(name -> 'type'|'value')
const importers = new Map()

for (const file of walk(MIRROR)) {
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const spec = stmt.moduleSpecifier.text
    if (!spec.startsWith('@/hermes-shim/')) continue
    const rel = spec.slice('@/hermes-shim/'.length)
    const bucket = names.get(rel) ?? new Map()
    names.set(rel, bucket)
    const set = importers.get(rel) ?? new Set()
    set.add(relative(MIRROR, file).replace(/\\/g, '/'))
    importers.set(rel, set)

    const clause = stmt.importClause
    if (!clause) continue
    const typeOnly = clause.isTypeOnly
    if (clause.name) bucket.set(clause.name.text, typeOnly ? 'type' : 'value')
    const nb = clause.namedBindings
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        const kind = typeOnly || el.isTypeOnly ? 'type' : 'value'
        const prev = bucket.get(el.name.text)
        bucket.set(el.name.text, prev === 'value' || kind === 'value' ? 'value' : 'type')
      }
    }
    if (nb && ts.isNamespaceImport(nb)) bucket.set('*', 'value')
  }
}

// How far does each shim module reach inside the shim tree / upstream app?
function reachOf(rel) {
  const seen = new Set()
  const stack = []
  for (const e of EXTS) {
    const p = join(SHIM, rel + e)
    if (existsSync(p)) {
      stack.push(p)
      break
    }
  }
  // Not in the shim yet: measure the upstream file's own closure instead.
  if (stack.length === 0) {
    for (const e of EXTS) {
      const p = UP + rel + e
      if (existsSync(p)) {
        stack.push(p)
        break
      }
    }
  }
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
      if (spec.startsWith('.')) {
        const abs = normalize(join(dirname(file), spec))
        for (const e of EXTS) {
          if (existsSync(abs + e)) {
            next = abs + e
            break
          }
        }
      } else if (spec.startsWith('@/')) {
        const abs = UP + spec.slice(2)
        for (const e of EXTS) {
          if (existsSync(abs + e)) {
            next = abs + e
            break
          }
        }
      }
      if (next) stack.push(next)
    }
  }
  return seen.size
}

let out = `shim modules imported by the mirror = ${names.size}\n`
const rows = [...names].map(([rel, bucket]) => ({
  rel,
  reach: reachOf(rel),
  names: [...bucket.entries()].sort(),
  files: importers.get(rel).size
}))
rows.sort((a, b) => b.reach - a.reach)

for (const r of rows) {
  out += `\n### ${r.rel}   reach=${r.reach} importers=${r.files}\n`
  out += '  ' + r.names.map(([n, k]) => (k === 'type' ? `${n}~` : n)).join(', ') + '\n'
}
writeFileSync(process.argv[2], out, 'utf8')
console.log('modules', names.size, '| max reach', Math.max(...rows.map(r => r.reach)))
