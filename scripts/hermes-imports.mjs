import { readFileSync, writeFileSync } from 'node:fs'

const SRC = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const targets = process.argv.slice(3)
let out = ''
for (const f of targets) {
  let t
  try {
    t = readFileSync(SRC + f, 'utf8')
  } catch {
    out += `=== ${f}  MISSING\n`
    continue
  }
  const imps = [...t.matchAll(/(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)].map(m => m[1])
  out += `=== ${f}  (${t.split(/\r?\n/).length} lines)\n   ${[...new Set(imps)].join('\n   ')}\n\n`
}
writeFileSync(process.argv[2], out, 'utf8')
console.log('ok')
