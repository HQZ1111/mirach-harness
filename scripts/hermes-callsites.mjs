// For each exported name of a shim module, list where the capabilities subtree
// uses it. Answers "does this need a real adapter or is it never called?".
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'src/hermes-mirror/app/capabilities'
const targets = process.argv.slice(2)

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const files = walk(ROOT).map(f => ({ path: f, text: readFileSync(f, 'utf8') }))

for (const name of targets) {
  const hits = []
  for (const f of files) {
    f.text.split(/\r?\n/).forEach((line, i) => {
      if (line.includes('import') || line.trim().startsWith('//')) return
      const re = new RegExp(`\\b${name}\\b`)
      if (re.test(line)) hits.push(`${f.path.replace(/\\/g, '/').replace(ROOT + '/', '')}:${i + 1}  ${line.trim()}`)
    })
  }
  console.log(`\n### ${name}  (${hits.length} call sites)`)
  for (const h of hits.slice(0, 8)) console.log('   ' + h)
  if (hits.length > 8) console.log(`   … ${hits.length - 8} more`)
}
