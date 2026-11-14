import { readFileSync, writeFileSync } from 'node:fs'

const t = readFileSync('D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/types/hermes.ts', 'utf8')
const names = process.argv.slice(3)
let out = ''
for (const n of names) {
  const i = t.indexOf('export interface ' + n)
  const j = t.indexOf('export type ' + n)
  const k = i >= 0 ? i : j
  if (k < 0) {
    out += `--- ${n} NOT FOUND\n\n`
    continue
  }
  const end = t.indexOf('\n}', k)
  out += t.slice(k, end + 2) + '\n\n'
}
writeFileSync(process.argv[2], out, 'utf8')
console.log('ok')
