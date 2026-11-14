import { readFileSync, writeFileSync } from 'node:fs'

// Reproduce the rewriter's walk on one file to see what resolves to shim 'git'.
// Hypothesis: a dynamic `import('git')`-style call inside a template? Search for
// any quoted token exactly 'git' inside import positions.
import ts from 'typescript'
import { readdirSync, readFileSync, statSync } from 'node:fs'
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
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      if (node.moduleSpecifier.text === 'git') {
        hits.push(`${f.replace(/\\/g, '/')}: ${node.getStart(sf)}`)
      }
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0]
      if (arg && ts.isStringLiteral(arg) && arg.text === 'git') {
        hits.push(`${f.replace(/\\/g, '/')}: dynamic import('git')`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
}
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/githits.txt', hits.join('\n') || '(none)', 'utf8')
console.log(hits.join('\n') || '(none)')
