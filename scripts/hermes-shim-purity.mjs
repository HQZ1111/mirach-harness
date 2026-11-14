// Which shim modules are genuinely self-contained? A verbatim copy is only
// justified when the module reaches no store, no gateway and no host window.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const rows = []
for (const f of walk('src/hermes-shim')) {
  const text = readFileSync(f, 'utf8')
  const specs = [...text.matchAll(/(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)].map(m => m[1])
  const couples = specs.filter(
    s =>
      s.includes('/store/') ||
      s.endsWith('hermes') ||
      s.includes('/api/') ||
      s.includes('/contrib/') ||
      s === 'react-router'
  )
  const host = /window\.hermesDesktop/.test(text) ? 'HOST' : ''
  rows.push({
    file: f.replace(/\\/g, '/').replace('src/hermes-shim/', ''),
    deps: specs.length,
    couples: couples.length,
    host,
    list: [...new Set(couples)].join(' ')
  })
}
rows.sort((a, b) => a.couples - b.couples)
for (const r of rows) {
  console.log(`${String(r.couples).padStart(3)} ${r.host.padEnd(5)} ${r.file.padEnd(46)} ${r.list}`)
}
