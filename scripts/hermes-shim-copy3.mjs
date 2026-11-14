import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const files = ['lib/legacy-session-owner-backfill.ts', 'lib/session-owner-stamp.ts', 'store/transcript-tail.ts']
for (const f of files) {
  const dest = 'src/hermes-shim/' + f
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(UP + f, dest)
  console.log('OK', f)
}
