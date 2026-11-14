import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const pairs = [
  ['app/gateway/hooks/use-gateway-request.ts', 'src/hermes-shim/app-gateway/hooks/use-gateway-request.ts'],
  ['global.d.ts', 'src/hermes-shim/global.d.ts']
]
for (const [a, b] of pairs) {
  mkdirSync(dirname(b), { recursive: true })
  copyFileSync(UP + a, b)
  console.log('OK', b)
}
