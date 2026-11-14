import { existsSync, rmSync } from 'node:fs'

const target = 'src/components/panes/capabilities'
rmSync(target, { recursive: true, force: true })
console.log('exists after delete =', existsSync(target))
