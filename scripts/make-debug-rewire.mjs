import { readFileSync, writeFileSync } from 'node:fs'

const t = readFileSync('scripts/hermes-rewire.mjs', 'utf8')
const dbg = t.replace(
  'if (!inShim(rel)) unresolved.add(rel)',
  `if (!inShim(rel)) { unresolved.add(rel); if (rel === 'git') console.log('GIT from', file) }`
)
writeFileSync('scripts/hermes-rewire-debug.mjs', dbg, 'utf8')
console.log('debug copy written =', dbg.includes("GIT from"))
