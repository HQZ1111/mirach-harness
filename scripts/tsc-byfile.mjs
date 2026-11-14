import { readFileSync, writeFileSync } from 'node:fs'

const t = readFileSync(process.argv[2], 'utf8')
const rows = []
for (const line of t.split(/\r?\n/)) {
  const m = line.match(/^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/)
  if (!m) continue
  rows.push({ f: m[1].replace(/\\/g, '/'), l: m[2], c: m[3], code: m[4], msg: m[5] })
}
rows.sort((a, b) => a.f.localeCompare(b.f) || Number(a.l) - Number(b.l))
let s = ''
let last = ''
for (const r of rows) {
  const key = r.f
  if (key !== last) {
    s += '\n=== ' + r.f + '\n'
    last = key
  }
  s += `  ${r.l}:${r.c}  ${r.code}  ${r.msg.slice(0, 150)}\n`
}
writeFileSync(process.argv[3], s, 'utf8')
console.log('errors', rows.length, 'files', new Set(rows.map(r => r.f)).size)
