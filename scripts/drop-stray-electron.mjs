import { existsSync, rmSync } from 'node:fs'

const target = 'src/electron'
rmSync(target, { recursive: true, force: true })
console.log('removed', target, '| exists =', existsSync(target))
