import { readFileSync, writeFileSync } from 'node:fs'

const p = 'scripts/hermes-shim-prune2.mjs'
let t = readFileSync(p, 'utf8')
const before = t.includes(`'lib/chat-runtime.ts'`)
// These three were KEEP entries to keep the *upstream* store/activity alive; the
// adapter replaces it, so the chat-runtime chain is prunable again.
t = t.replace(`,
  'lib/chat-runtime.ts',
  'store/preview.ts',
  'components/error-boundary.tsx'`, '')
writeFileSync(p, t, 'utf8')
console.log('chain entries removed =', before && !t.includes(`'lib/chat-runtime.ts'`))
