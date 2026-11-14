import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const log = process.argv[2]
const out = process.argv[3]
if (!existsSync(log)) {
  console.log('log not found')
  process.exit(0)
}
const text = readFileSync(log, 'utf8')
const lines = text.split(/\r?\n/).filter(l => / error TS/.test(l))
const areas = { mirror: 0, shim: 0, host: 0 }
const hostFiles = new Map()
const byCode = new Map()
for (const l of lines) {
  const m = l.match(/^(.*?)\((\d+),(\d+)\): error (TS\d+): (.*)$/)
  if (!m) continue
  const f = m[1].replace(/\\/g, '/')
  const area = f.includes('hermes-mirror') ? 'mirror' : f.includes('hermes-shim') ? 'shim' : 'host'
  areas[area]++
  if (area === 'host') hostFiles.set(f, (hostFiles.get(f) ?? 0) + 1)
  const c = m[4]
  const e = byCode.get(c) ?? { n: 0, sample: [] }
  e.n++
  if (e.sample.length < 2) e.sample.push(m[5].slice(0, 140))
  byCode.set(c, e)
}
let s = `total=${lines.length}\n` + JSON.stringify(areas) + '\n\n--- by code ---\n'
for (const [c, e] of [...byCode].sort((a, b) => b[1].n - a[1].n)) {
  s += `${c} x${e.n}\n   ${e.sample.join('\n   ')}\n`
}
s += '\n--- host files with errors ---\n'
for (const [f, n] of [...hostFiles].sort((a, b) => b[1] - a[1])) s += `${String(n).padStart(4)}  ${f}\n`
writeFileSync(out, s, 'utf8')
console.log(`total=${lines.length}`, areas)
