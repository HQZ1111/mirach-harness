// One-off diagnostic: group `Cannot find module` errors from a tsc log by the
// importing file, so the shim layer can be built file-by-file.
import { readFileSync, writeFileSync } from 'node:fs'

const log = process.argv[2]
const out = process.argv[3]
const text = readFileSync(log, 'utf8')
const rows = []
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^(.*?)\((\d+),(\d+)\): error TS2307: Cannot find module '([^']+)'/)
  if (m) rows.push({ file: m[1], mod: m[4] })
}
const byFile = new Map()
for (const r of rows) {
  const list = byFile.get(r.file) ?? []
  list.push(r.mod)
  byFile.set(r.file, list)
}
let s = `total=${rows.length} files=${byFile.size}\n`
for (const [f, mods] of [...byFile].sort()) {
  s += `\n${f}\n`
  for (const m of [...new Set(mods)].sort()) s += `  ${m}\n`
}
writeFileSync(out, s, 'utf8')
console.log('ok', rows.length, byFile.size)
