import { readFileSync, writeFileSync } from 'node:fs'

const p = 'scripts/hermes-shim-prune2.mjs'
let t = readFileSync(p, 'utf8')
const before = t.includes('statSync(target).isFile()')
t = t.replace(
  'if (existsSync(target) && !keep.has(target)) queue.push(target)',
  'if (existsSync(target) && statSync(target).isFile() && !keep.has(target)) queue.push(target)'
)
writeFileSync(p, t, 'utf8')
console.log('isFile guard present =', t.includes('statSync(target).isFile()'), '| was already =', before)
