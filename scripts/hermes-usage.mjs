// For each shim module, list the *call sites* in the capabilities subtree that
// use it — so an adapter can be written against real usage instead of against a
// name list.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src/hermes-mirror'
const only = process.argv[2] // e.g. '@/hermes-shim/store/gateway'

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const hits = []
for (const file of walk(ROOT)) {
  if (!file.includes('app/capabilities')) continue
  const text = readFileSync(file, 'utf8')
  if (!text.includes(only)) continue
  const lines = text.split(/\r?\n/)
  lines.forEach((line, i) => {
    if (line.includes(only.replace(/^@\//, '')) || line.includes(only)) {
      hits.push(`${file.replace(/\\/g, '/')}:${i + 1}  ${line.trim()}`)
    }
  })
}
console.log(hits.join('\n'))
