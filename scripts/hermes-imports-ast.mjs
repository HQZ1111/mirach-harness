// Exact import contract per shim module, using the TypeScript parser instead of
// regexes (multi-line import clauses and side-effect imports both broke the
// regex approach).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const ROOT = process.argv[2]
const out = process.argv[3]

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const byModule = new Map()

for (const file of walk(ROOT)) {
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue
    const spec = stmt.moduleSpecifier.text
    if (!spec.startsWith('@/hermes-shim/')) continue
    const bucket = byModule.get(spec) ?? new Map()
    byModule.set(spec, bucket)
    const clause = stmt.importClause
    if (!clause) continue // side-effect import
    const isTypeOnly = clause.isTypeOnly
    if (clause.name) bucket.set(clause.name.text, isTypeOnly ? 'type' : 'value')
    const nb = clause.namedBindings
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        const kind = isTypeOnly || el.isTypeOnly ? 'type' : 'value'
        const prev = bucket.get(el.name.text)
        bucket.set(el.name.text, prev === 'value' || kind === 'value' ? 'value' : 'type')
      }
    }
    if (nb && ts.isNamespaceImport(nb)) bucket.set('*', 'value')
  }
}

let s = ''
for (const [spec, names] of [...byModule].sort()) {
  s += `\n### ${spec.replace('@/hermes-shim/', '')}\n`
  for (const [n, kind] of [...names].sort()) s += `  ${n}${kind === 'type' ? '  [type]' : ''}\n`
}
writeFileSync(out, s, 'utf8')
console.log('modules', byModule.size)
