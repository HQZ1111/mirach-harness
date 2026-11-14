// Size + external-dep survey for a set of upstream files, so we can budget
// what to copy verbatim vs. what needs a host adapter.
import { readFileSync, statSync } from 'node:fs'

const SRC = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const targets = process.argv.slice(2)
let total = 0
for (const t of targets) {
  const p = SRC + t
  try {
    const st = statSync(p)
    const lines = readFileSync(p, 'utf8').split(/\r?\n/).length
    total += lines
    console.log(`${String(lines).padStart(6)}  ${(st.size / 1024).toFixed(1).padStart(7)}KB  ${t}`)
  } catch {
    console.log(`   MISS  ${t}`)
  }
}
console.log(`${String(total).padStart(6)}  TOTAL`)
