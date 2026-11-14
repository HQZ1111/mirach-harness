import { readFileSync, writeFileSync } from 'node:fs'

const p = 'src/hermes-shim/hermes.ts'
let t = readFileSync(p, 'utf8')
// LearningNodeDetail + ModelOptionsResult are NOT in the mirror's types file —
// upstream declares them inline in api/skills.ts and api/models.ts. They are
// declared locally further down; drop them from both import lists.
t = t.replace(/[ \t]*LearningNodeDetail,\r?\n/g, '')
t = t.replace(/[ \t]*ModelOptionsResult,\r?\n/g, '')
writeFileSync(p, t, 'utf8')
console.log(
  'LearningNodeDetail occurrences =',
  (t.match(/LearningNodeDetail/g) ?? []).length,
  '| ModelOptionsResult =',
  (t.match(/ModelOptionsResult/g) ?? []).length
)
