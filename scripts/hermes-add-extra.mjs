import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const D = 'src/hermes-mirror/'
const add = [
  'types/hermes.ts',
  'lib/tool-result-metadata.ts',
  'i18n/catalog.ts',
  'i18n/context.tsx',
  'i18n/runtime.ts',
  'i18n/registry.ts',
  'i18n/languages.ts',
  'i18n/define-locale.ts',
  'i18n/plugin-i18n.ts',
  'i18n/localized-tab-title.tsx',
  'i18n/intro-zh.ts'
]
const log = []
for (const f of add) {
  const src = UP + f
  if (!existsSync(src)) {
    log.push(`MISS ${f}`)
    continue
  }
  mkdirSync(dirname(D + f), { recursive: true })
  copyFileSync(src, D + f)
  log.push(`OK   ${f}`)
}
log.push('')
log.push('--- mirror i18n now ---')
for (const n of readdirSync(D + 'i18n')) log.push('  ' + n)
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/add.log', log.join('\n'), 'utf8')
