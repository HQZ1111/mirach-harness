import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(d, acc = []) {
  for (const n of readdirSync(d)) {
    const q = join(d, n)
    if (statSync(q).isDirectory()) walk(q, acc)
    else if (/\.(ts|tsx)$/.test(n)) acc.push(q.replace(/\\/g, '/'))
  }
  return acc
}
const files = walk(process.argv[2])
const cap = files.filter(f => f.includes('capabilities'))
console.log('ts files', files.length, '| capabilities', cap.length)
for (const f of cap.slice(0, 5)) console.log('  ', f)
