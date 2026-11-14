import { existsSync, rmSync } from 'node:fs'

const p = 'src/hermes-shim/global.d.ts'
rmSync(p, { force: true })
console.log('removed', p, '| exists =', existsSync(p))
