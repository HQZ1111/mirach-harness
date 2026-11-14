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
  const re = /from\s+['"]git['"]/g
  let m
  while ((m = re.exec(t))) {
    hits.push(`${f.replace(/\\/g, '/')}: ${t.slice(Math.max(0, m.index - 80), m.index + 40).replace(/\n/g, ' ')}`)
  }
}
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/gitfrom.txt', hits.join('\n') || '(none)', 'utf8')
console.log(hits.join('\n') || '(none)')
