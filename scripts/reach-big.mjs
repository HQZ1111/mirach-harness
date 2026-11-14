import { readFileSync, writeFileSync } from 'node:fs'

const t = readFileSync('C:/Users/Administrator/AppData/Local/Temp/reach4.txt', 'utf8')
const lines = t.split(/\r?\n/).filter(l => l.trim())
const big = lines.filter(l => Number(l.split(/\s+/)[0]) > 40)
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/reach-big.txt', big.join('\n'), 'utf8')
console.log('big-reach modules:', big.length, 'of', lines.length)
