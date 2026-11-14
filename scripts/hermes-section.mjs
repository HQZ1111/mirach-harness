import { readFileSync, writeFileSync } from 'node:fs'

const t = readFileSync(process.argv[2], 'utf8')
const want = process.argv[4]
const i = t.indexOf('### ' + want + '\n')
if (i < 0) {
  console.log('not found')
  process.exit(1)
}
const j = t.indexOf('\n### ', i + 1)
writeFileSync(process.argv[3], t.slice(i, j < 0 ? undefined : j), 'utf8')
console.log('ok')
