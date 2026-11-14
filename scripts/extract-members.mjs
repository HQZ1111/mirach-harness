import { readFileSync, writeFileSync } from 'node:fs'

const t = readFileSync('D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/global.d.ts', 'utf8')
const names = process.argv.slice(2)
let out = ''
for (const n of names) {
  const i = t.indexOf(n + ':')
  if (i < 0) {
    out += `--- ${n} NOT FOUND\n`
    continue
  }
  // Take from the line start to the next blank line (members are separated by
  // blank lines in that file).
  const start = t.lastIndexOf('\n', i) + 1
  const end = t.indexOf('\n\n', i)
  out += t.slice(start, end < 0 ? i + 600 : end) + '\n\n'
}
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/bridge-members.txt', out, 'utf8')
console.log('extracted', names.length)
