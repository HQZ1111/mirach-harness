import { readFileSync, writeFileSync } from 'node:fs'

const t = readFileSync('C:/Users/Administrator/AppData/Local/Temp/tscFinal.txt', 'utf8')
const byFile = {}
for (const line of t.split(/\r?\n/)) {
  const m = line.match(/^src\/([^(]+)\(/)
  if (!m) continue
  const f = m[1]
  byFile[f] = (byFile[f] || 0) + 1
}
writeFileSync(
  'C:/Users/Administrator/AppData/Local/Temp/final-dist.txt',
  Object.entries(byFile)
    .map(([f, n]) => `${String(n).padStart(4)}  ${f}`)
    .sort((a, b) => parseInt(b) - parseInt(a))
    .join('\n'),
  'utf8'
)
console.log('written')
