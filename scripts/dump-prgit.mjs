import { readFileSync, writeFileSync } from 'node:fs'

const t = readFileSync('src/hermes-shim/store/pull-requests.ts', 'utf8')
const i = t.indexOf("'git'")
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/prgit.txt', t.slice(Math.max(0, i - 400), i + 200), 'utf8')
console.log('at', i)
