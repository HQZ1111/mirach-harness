// Exact import contract every shim module must satisfy: for each
// `@/hermes-shim/<path>` specifier, which names are imported and whether they
// are used as types, values, or both. Written so the shim layer is derived from
// the mirror instead of guessed.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src/hermes-mirror'

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const need = new Map() // shim path -> Map(name -> Set('type'|'value'))

function add(spec, name, kind) {
  if (!spec.startsWith('@/hermes-shim/')) return
  const p = spec.slice('@/hermes-shim/'.length)
  const bucket = need.get(p) ?? new Map()
  const kinds = bucket.get(name) ?? new Set()
  kinds.add(kind)
  bucket.set(name, kinds)
  need.set(p, bucket)
}

for (const file of walk(ROOT)) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const isType = Boolean(m[1])
    const clause = m[2].trim()
    const spec = m[3]
    if (!spec.startsWith('@/hermes-shim/')) continue

    const braces = clause.match(/\{([\s\S]*)\}/)
    if (braces) {
      for (const raw of braces[1].split(',')) {
        const part = raw.trim()
        if (!part) continue
        const inlineType = /^type\s+/.test(part)
        const name = part.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
        if (name) add(spec, name, isType || inlineType ? 'type' : 'value')
      }
    }
    const def = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim()
    if (def && !def.startsWith('*')) add(spec, def, isType ? 'type' : 'value')
    if (/\*\s+as\s+/.test(clause)) add(spec, '*', isType ? 'type' : 'value')
  }
}

let out = ''
for (const [p, names] of [...need].sort()) {
  out += `\n### ${p}\n`
  for (const [n, kinds] of [...names].sort()) {
    const t = kinds.has('type')
    const v = kinds.has('value')
    out += `  ${n}${t && !v ? '  [type]' : ''}${t && v ? '  [both]' : ''}\n`
  }
}
console.log(out)
