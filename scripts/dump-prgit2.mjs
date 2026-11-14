import { readFileSync, writeFileSync } from 'node:fs'

const t = readFileSync('src/hermes-shim/store/pull-requests.ts', 'utf8')
const hits = []
t.split(/\r?\n/).forEach((l, i) => {
  if (/\bgit\b/i.test(l)) hits.push(`${i + 1}: ${l.trim().slice(0, 120)}`)
})
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/prgit.txt', hits.join('\n') || '(none)', 'utf8')
console.log(hits.join('\n') || '(none)')
