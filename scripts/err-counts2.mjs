import { readFileSync, writeFileSync } from 'node:fs'

const t = readFileSync('C:/Users/Administrator/AppData/Local/Temp/byR.txt', 'utf8')
const blocks = t.split(/\r?\n=== /).slice(1)
const counts = blocks.map(b => {
  const name = b.slice(0, b.indexOf('\n')).trim()
  const n = b.split(/\r?\n/).length - 1
  return `${String(n).padStart(4)}  ${name.replace('src/hermes-mirror/', 'M:').replace('src/hermes-shim/', 'S:').replace('src/', '')}`
})
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/cntsR.txt', counts.join('\n'), 'utf8')
console.log(counts.join('\n'))
