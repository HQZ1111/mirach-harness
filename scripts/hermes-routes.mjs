import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const paths = new Map()
for (const f of walk(process.argv[2])) {
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(/path:\s*[`'"]([^`'"]+)[`'"]/g)) {
    const route = m[1].replace(/\$\{[^}]*\}/g, ':p').replace(/\?.*$/, '')
    const set = paths.get(route) ?? new Set()
    set.add(f.replace(/\\/g, '/'))
    paths.set(route, set)
  }
}
let s = ''
for (const [k, files] of [...paths].sort()) s += `${k}\n    ${[...files].join(', ')}\n`
writeFileSync(process.argv[3], s, 'utf8')
console.log('routes', paths.size)
