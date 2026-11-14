import { existsSync, rmSync } from 'node:fs'

const p = 'src/hermes-shim/app-gateway'
rmSync(p, { recursive: true, force: true })
console.log('removed', p, '| exists =', existsSync(p))
