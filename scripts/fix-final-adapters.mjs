import { readFileSync, writeFileSync } from 'node:fs'

const p = 'scripts/hermes-shim-final-adapters.mjs'
let t = readFileSync(p, 'utf8')
t = t.replace(
  "import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'",
  "import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'"
)
writeFileSync(p, t, 'utf8')
console.log('imports fixed =', t.includes("existsSync, mkdirSync, rmSync, writeFileSync"))
