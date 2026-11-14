import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/hermes-shim/bridge.ts'
let text = readFileSync(path, 'utf8')
text = text.replace("from '@/hermes-shim/lib/ipc'", "from '@/lib/ipc'")
writeFileSync(path, text, 'utf8')
console.log('bridge.ts ipc import now points at the host wrapper')
