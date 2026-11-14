// Find who imports '@/git' — the rewire resolves '@/git' to shim module 'git',
// which is the persistent unresolved entry.
import ts from 'typescript'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function walk(d, acc = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(n)) acc.push(p)
  }
  return acc
}
const hits = []
for (const f of [...walk('src/hermes-shim'), ...walk('src/hermes-mirror')]) {
  const text = readFileSync(f, 'utf8')
  const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = node => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@/git') {
      hits.push(`${f.replace(/\\/g, '/')} :: ${node.getStart(sf)}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/gitat.txt', hits.join('\n') || '(none)', 'utf8')
console.log(hits.join('\n') || '(none)')
