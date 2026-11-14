// Copy the boundary modules verbatim into `src/hermes-shim/`, at their upstream
// path. Most of them (the small nanostores modules) are already host-agnostic —
// they only needed to be outside the mirror because the mirror's closure stops
// there. The ones that DO reach the host (hermes.ts, api/*, store/gateway,
// store/session, store/profile, store/notifications, store/session-states,
// store/connections, contrib/*) get overwritten with real adapters afterwards;
// having the upstream file present first means the adapter diff is explicit.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const SHIM = 'src/hermes-shim/'
const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

const rels = readFileSync('C:/Users/Administrator/AppData/Local/Temp/gaps.txt', 'utf8')
  .split('--- missing (need a file) ---')[1]
  .split(/\r?\n/)
  .filter(l => /^\s*\d+\s+\S/.test(l))
  .map(l => l.trim().split(/\s+/)[1])

const log = []
for (const rel of rels) {
  let src = null
  for (const e of EXTS) {
    const p = UP + rel + e
    if (existsSync(p)) {
      src = p
      break
    }
  }
  if (!src) {
    log.push(`MISS ${rel}`)
    continue
  }
  const destRel = rel + src.slice(UP.length + rel.length)
  const dest = join(SHIM, destRel)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  log.push(`OK   ${destRel}`)
}
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/shimcopy.log', log.join('\n'), 'utf8')
console.log(log.join('\n'))
