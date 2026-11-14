// For every `@/hermes-shim/*` module, print the names the *capabilities page*
// imports (not the whole mirror). This is the actual adapter contract: anything
// not listed is only used by upstream code paths the host doesn't render.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src/hermes-mirror/app/capabilities'
const out = process.argv[2]

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

// Side-effect imports (`import './page.css'`) have no `from`, so a naive
// `import … from` regex swallows every statement up to the next `from` and
// reports garbage names. Strip them first.
const stripSideEffects = text => text.replace(/(^|\n)\s*import\s+['"][^'"]+['"]/g, '$1')

const files = walk(ROOT).map(f => ({ path: f, text: stripSideEffects(readFileSync(f, 'utf8')) }))
const byModule = new Map()

for (const f of files) {
  for (const m of f.text.matchAll(/import\s+(type\s+)?([\s\S]*?)\s+from\s+['"](@\/hermes-shim\/[^'"]+)['"]/g)) {
    const isType = Boolean(m[1])
    const clause = m[2].trim()
    const spec = m[3]
    const bucket = byModule.get(spec) ?? new Map()
    byModule.set(spec, bucket)
    const add = (n, kind) => {
      const e = bucket.get(n) ?? new Set()
      e.add(kind)
      bucket.set(n, e)
    }
    const braces = clause.match(/\{([\s\S]*)\}/)
    if (braces) {
      for (const raw of braces[1].split(',')) {
        const part = raw.trim()
        if (!part) continue
        const inlineType = /^type\s+/.test(part)
        const n = part.replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
        if (n) add(n, isType || inlineType ? 'type' : 'value')
      }
    }
    const def = clause.replace(/\{[\s\S]*\}/, '').replace(/,/g, '').trim()
    if (def && !def.startsWith('*')) add(def, isType ? 'type' : 'value')
  }
}

let s = ''
for (const [spec, names] of [...byModule].sort()) {
  s += `\n### ${spec.replace('@/hermes-shim/', '')}\n`
  for (const [n, kinds] of [...names].sort()) {
    const t = kinds.has('type')
    const v = kinds.has('value')
    s += `  ${n}${t && !v ? '  [type]' : ''}\n`
  }
}
writeFileSync(out, s, 'utf8')
console.log('modules', byModule.size)
