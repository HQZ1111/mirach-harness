import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src/hermes-mirror/app/capabilities'
function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}
const files = walk(ROOT)
console.log('files =', files.length)
const sample = join(ROOT, 'skills', 'skills-data.ts')
const text = readFileSync(sample, 'utf8')
const re = /import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g
const matches = [...text.matchAll(re)]
console.log('matches =', matches.length)
for (const m of matches) console.log('  ', JSON.stringify(m[3]), '|', JSON.stringify(m[2].slice(0, 40)))
