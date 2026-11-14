// Mirror the whole upstream `api/` layer into the shim. It is a thin REST
// wrapper over one bridge function (`window.hermesDesktop.api`), so keeping it
// verbatim means the page's data calls stay upstream code — the host only has to
// satisfy that one function (see `bridge.ts`).
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'

const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/api/'
const DEST = 'src/hermes-shim/api/'

const log = []
for (const name of readdirSync(UP)) {
  if (!/\.ts$/.test(name)) continue
  if (/\.test\./.test(name)) continue
  const src = UP + name
  if (!existsSync(src)) {
    log.push(`MISS ${name}`)
    continue
  }
  mkdirSync(DEST, { recursive: true })
  copyFileSync(src, DEST + name)
  log.push(`OK   ${name}`)
}
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/api-copy.log', log.join('\n'), 'utf8')
console.log('copied', log.filter(l => l.startsWith('OK')).length)
