import { readdirSync, readFileSync, writeFileSync } from 'node:fs'

const dir = process.argv[2]
const out = process.argv[3]
const rows = []
for (const f of readdirSync(dir)) {
  if (!/\.(ts|tsx)$/.test(f)) continue
  const t = readFileSync(dir + '/' + f, 'utf8')
  const host = (t.match(/hermesDesktop/g) ?? []).length
  rows.push(`${String(t.split(/\r?\n/).length).padStart(5)} lines  host=${String(host).padStart(3)}  ${f}`)
}
writeFileSync(out, rows.join('\n'), 'utf8')
console.log(rows.join('\n'))
