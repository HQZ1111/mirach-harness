import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src/hermes-mirror'
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}
const files = walk(ROOT).map(f => ({ f, t: readFileSync(f, 'utf8') }))
for (const w of process.argv.slice(2)) {
  const hits = []
  for (const { f, t } of files) {
    if (!new RegExp('\\b' + w + '\\b').test(t)) continue
    t.split(/\r?\n/).forEach((l, i) => {
      if (!l.includes(w)) return
      if (/^\s*(import|export)\b/.test(l)) return
      if (/^\s*(\/\/|\*|\/\*)/.test(l)) return
      hits.push(`${f.replace(/\\/g, '/').replace(ROOT + '/', '')}:${i + 1}  ${l.trim().slice(0, 100)}`)
    })
  }
  console.log(`\n### ${w}  (${hits.length})`)
  for (const h of hits.slice(0, 10)) console.log('   ' + h)
}
