import { readFileSync, writeFileSync } from 'node:fs'

const t = readFileSync(process.argv[2], 'utf8')
const skip = new Set(
  (process.argv[4] ?? '').split(',').filter(Boolean)
)
const secs = t.split(/\n(?=### )/).filter(s => s.trim())
let out = ''
for (const s of secs) {
  const lines = s.trim().split('\n')
  const name = lines[0].replace('### ', '')
  if (skip.has(name)) continue
  const names = lines.slice(1).map(l => l.trim().replace('  [type]', '~'))
  out += `${name}: ${names.join(', ')}\n`
}
writeFileSync(process.argv[3], out, 'utf8')
console.log('ok')
