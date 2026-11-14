// For each name imported from a given shim module, print the call sites in the
// capabilities subtree. Used to size adapters against real usage.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src/hermes-mirror/app/capabilities'
const shim = process.argv[2]
const out = process.argv[3]

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const files = walk(ROOT).map(f => ({ path: f, text: readFileSync(f, 'utf8') }))
const names = new Set()

// Collect the imported names for this shim module.
for (const f of files) {
  for (const m of f.text.matchAll(/import\s+(?:type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)) {
    if (m[2] !== shim) continue
    const braces = m[1].match(/\{([\s\S]*)\}/)
    if (!braces) continue
    for (const raw of braces[1].split(',')) {
      const n = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()
      if (n) names.add(n)
    }
  }
}

let report = `shim = ${shim}\nimported names = ${names.size}\n`
for (const name of [...names].sort()) {
  const hits = []
  for (const f of files) {
    f.text.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(import|export)\b/.test(line) || line.trim().startsWith('//') || line.trim().startsWith('*')) return
      if (new RegExp(`\\b${name}\\b`).test(line)) {
        hits.push(`  ${f.path.replace(/\\/g, '/').replace(ROOT + '/', '')}:${i + 1}  ${line.trim()}`)
      }
    })
  }
  report += `\n## ${name}  (${hits.length})\n${hits.join('\n')}\n`
}
writeFileSync(out, report, 'utf8')
console.log('names', names.size)
