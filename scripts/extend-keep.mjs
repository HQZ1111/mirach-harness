import { readFileSync, writeFileSync } from 'node:fs'

const p = 'scripts/hermes-shim-prune2.mjs'
let t = readFileSync(p, 'utf8')
if (!t.includes(`'lib/chat-runtime.ts'`)) {
  t = t.replace(`  'store/windows.ts'`, `  'store/windows.ts',\n  'lib/chat-runtime.ts',\n  'store/preview.ts',\n  'components/error-boundary.tsx'`)
  writeFileSync(p, t, 'utf8')
  console.log('KEEP extended with activity-chain modules')
} else {
  console.log('KEEP already extended')
}
