import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const d = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/i18n'
let n = 0
let bytes = 0
const rows = []
for (const f of readdirSync(d)) {
  if (!/\.(ts|tsx)$/.test(f)) continue
  if (/test/.test(f)) continue
  const s = statSync(join(d, f))
  n++
  bytes += s.size
  rows.push(`${String(s.size).padStart(8)}  ${f}`)
}
rows.sort((a, b) => b.length - a.length)
writeFileSync(
  'C:/Users/Administrator/AppData/Local/Temp/i18nsize.txt',
  `files=${n} MB=${(bytes / 1048576).toFixed(2)}\n` + rows.join('\n'),
  'utf8'
)
