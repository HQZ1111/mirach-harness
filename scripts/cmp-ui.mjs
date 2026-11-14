import { readFileSync, writeFileSync } from 'node:fs'

const names = process.argv.slice(3)
const out = process.argv[2]
const up = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/components/ui/'
let s = ''
for (const n of names) {
  const a = readFileSync(`src/components/ui/${n}.tsx`, 'utf8').split(/\r?\n/)
  const b = readFileSync(up + n + '.tsx', 'utf8').split(/\r?\n/)
  const aset = new Set(a.map(x => x.trim()).filter(Boolean))
  const bset = new Set(b.map(x => x.trim()).filter(Boolean))
  let inHost = 0
  for (const l of b) if (aset.has(l.trim())) inHost++
  let inUp = 0
  for (const l of a) if (bset.has(l.trim())) inUp++
  s += `${n}: host=${a.length} up=${b.length} upInHost=${inHost} hostInUp=${inUp}\n`
}
writeFileSync(out, s, 'utf8')
console.log('ok')
