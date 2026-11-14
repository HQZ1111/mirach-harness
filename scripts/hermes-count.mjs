import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function count(d) {
  let n = 0
  let l = 0
  for (const x of readdirSync(d)) {
    const q = join(d, x)
    const s = statSync(q)
    if (s.isDirectory()) {
      const r = count(q)
      n += r.n
      l += r.l
    } else if (/\.(ts|tsx|css|json)$/.test(x)) {
      n++
      l += readFileSync(q, 'utf8').split(/\r?\n/).length
    }
  }
  return { n, l }
}
for (const d of process.argv.slice(2)) {
  const r = count(d)
  console.log(`${d}: files=${r.n} lines=${r.l}`)
}
