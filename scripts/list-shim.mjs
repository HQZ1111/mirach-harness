import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function walk(d, acc = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) walk(p, acc)
    else acc.push(p.replace(/\\/g, '/'))
  }
  return acc
}
const files = walk('src/hermes-shim')
writeFileSync(
  'C:/Users/Administrator/AppData/Local/Temp/shimlist.txt',
  files.map(f => f.replace('src/hermes-shim/', '')).sort().join('\n'),
  'utf8'
)
console.log('shim files', files.length)
