import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(d, acc = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(n)) acc.push(p)
  }
  return acc
}
for (const f of [...walk('src/hermes-shim'), ...walk('src/hermes-mirror')]) {
  const t = readFileSync(f, 'utf8')
  if (t.includes("@/hermes-shim/git'") || t.includes('from "./git"') || t.includes("from '../git'")) {
    console.log(f)
  }
}
