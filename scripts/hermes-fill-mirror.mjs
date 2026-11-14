// Fill the remaining structural gaps in the mirror: the i18n barrel + runtime
// modules the closure can't see (it stops at `@/i18n`), the shared subpath
// modules, and the `catalog-curation.json` import that upstream reaches through
// a path outside the app (`../../../../../shared/src/…`).
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const SHARED = 'D:/新建文件夹 (5)/hermes-agent-main/apps/shared/src/'
const MIRROR = 'src/hermes-mirror/'

const log = []

function put(src, dest) {
  if (!existsSync(src)) {
    log.push(`MISS ${src}`)
    return
  }
  mkdirSync(dirname(MIRROR + dest), { recursive: true })
  copyFileSync(src, MIRROR + dest)
  log.push(`OK   ${dest}`)
}

// i18n barrel + the modules it re-exports. `index.ts` is what
// `import { useI18n } from '@/i18n'` resolves to upstream.
put(UP + 'i18n/index.ts', 'i18n/index.ts')
put(UP + 'i18n/profile-provider.tsx', 'i18n/profile-provider.tsx')
put(UP + 'i18n/backend-packs.ts', 'i18n/backend-packs.ts')

// The shared package's subpath modules (tsconfig maps them individually).
for (const name of readdirSync(SHARED)) {
  if (!/\.(ts|json)$/.test(name)) continue
  if (/\.test(-d)?\.ts$/.test(name)) continue
  put(SHARED + name, 'shared/' + name)
}

// Only the en + zh bundles: the host ships two languages (AGENTS.md rule 2).
// `catalog.ts` is NOT copied from upstream — it registers all nine, so the
// mirror gets a host catalog with the same export shape (written separately,
// see src/hermes-mirror/i18n/catalog.ts).
for (const name of readdirSync(UP + 'i18n')) {
  if (!/^(en|zh)[_.]/.test(name) && !/^(en|zh)\.ts$/.test(name)) continue
  if (/\.test\./.test(name)) continue
  put(UP + 'i18n/' + name, 'i18n/' + name)
}

writeFileSync('C:/Users/Administrator/AppData/Local/Temp/fill.log', log.join('\n'), 'utf8')
console.log(log.filter(l => l.startsWith('MISS')).join('\n') || 'all copied')
