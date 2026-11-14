// Inventory every import binding the capabilities tree takes from the shim
// surface (i18n / hermes / store / lib / types / shared / react-router), so the
// shim modules can be written to exactly that contract instead of guessed.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src/components/panes/capabilities/hermes'
const SHIM_PREFIXES = [
  '@/i18n',
  '@/hermes',
  '@/store/',
  '@/lib/',
  '@/types/',
  '@/api/',
  '@/contrib/',
  '@/app/',
  '@/components/',
  '@/global',
  '@hermes/shared',
  'react-router'
]

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const files = walk(ROOT)
const imports = new Map() // specifier -> Map(importedName -> Set(files))

for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    const isType = Boolean(m[1])
    const clause = m[2].trim()
    const spec = m[3]
    if (!SHIM_PREFIXES.some(p => spec === p || spec.startsWith(p))) continue
    const names = []
    const braces = clause.match(/\{([\s\S]*)\}/)
    if (braces) {
      for (const part of braces[1].split(',')) {
        const t = part.trim()
        if (!t) continue
        names.push(t.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim())
      }
    }
    const def = clause.replace(/\{[\s\S]*\}/, '').replace(/^\*\s+as\s+/, '').replace(/,/g, '').trim()
    if (def && !def.startsWith('*')) names.push(def === '' ? null : def)
    if (/\*\s+as\s+/.test(clause)) names.push('*')
    const bucket = imports.get(spec) ?? new Map()
    for (const n of names) {
      if (!n) continue
      const set = bucket.get(n) ?? new Set()
      set.add(isType ? 'type' : 'value')
      bucket.set(n, set)
    }
    imports.set(spec, bucket)
  }
}

let out = ''
for (const [spec, names] of [...imports].sort()) {
  out += `\n### ${spec}\n`
  for (const [n, kinds] of [...names].sort()) {
    out += `  ${n}${kinds.has('type') && !kinds.has('value') ? ' (type)' : ''}\n`
  }
}
console.log(out)
