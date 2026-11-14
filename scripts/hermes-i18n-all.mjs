// Copy the full i18n catalog set verbatim.
//
// Why all nine locales and not just en/zh: `i18n/catalog.ts` declares
// `TRANSLATIONS: Record<BundledLocale, Translations>` and `BundledLocale` is a
// nine-member union in `types.ts` (also verbatim). Registering a subset would
// mean editing either file, i.e. forking upstream types — the exact thing that
// produced the look-alike page before. The host's own language picker still
// offers two languages (`src/lib/ui-prefs.ts`); these catalogs are just the
// message tables the mirrored components resolve against.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/i18n/'
const DEST = 'src/hermes-mirror/i18n/'

const log = []
for (const name of readdirSync(UP)) {
  if (!/\.(ts|tsx)$/.test(name)) continue
  if (/\.test\./.test(name)) continue
  const src = UP + name
  if (!existsSync(src)) {
    log.push(`MISS ${name}`)
    continue
  }
  mkdirSync(DEST, { recursive: true })
  copyFileSync(src, join(DEST, name))
  log.push(`OK   ${name}`)
}
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/i18n-all.log', log.join('\n'), 'utf8')
console.log('copied', log.filter(l => l.startsWith('OK')).length)
