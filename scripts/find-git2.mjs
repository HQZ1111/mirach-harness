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
  const t = readFileSync(f, 'utf8')
  if (t.includes('hermes-shim/git')) {
    t.split(/\r?\n/).forEach((line, i) => {
      if (line.includes('hermes-shim/git')) hits.push(`${f.replace(/\\/g, '/')}:${i + 1}  ${line.trim().slice(0, 120)}`)
    })
  }
}
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/gitfind.txt', hits.join('\n') || '(none)', 'utf8')
console.log(hits.join('\n') || '(none)')
