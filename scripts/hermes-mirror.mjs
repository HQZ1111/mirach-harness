// Mirror the upstream hermes desktop tree into `src/hermes/` at identical
// relative paths: exactly the files the capabilities page needs (the pruned
// closure from `hermes-copy-set.mjs`), plus the i18n bundles that closure can't
// reach because `@/i18n` is a host boundary (the host adapter picks zh/en).
//
// Why a separate namespace instead of writing into `src/components/ui/…`:
// the host already has files at those paths (shadcn primitives) whose behaviour
// every existing page depends on. Overwriting them would change the whole app
// to fix one page. Under `src/hermes/` the mirror is byte-identical, and the
// codemod rewires the mirror's internal imports to point at itself.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const SHARED = 'D:/新建文件夹 (5)/hermes-agent-main/apps/shared/src/'
const DEST_ROOT = 'src/hermes-mirror/'

const listFile = process.argv[2]
const reportFile = process.argv[3]
const dryRun = process.argv.includes('--dry-run')

// Rebuild from scratch every run: the rewire step mutates the mirror in place,
// so copying on top of a rewired tree silently keeps rewritten specifiers.
if (!dryRun) rmSync(DEST_ROOT, { recursive: true, force: true })

const files = new Set(
  readFileSync(listFile, 'utf8')
    .split('--- boundary')[0]
    .split(/\r?\n/)
    .filter(l => l.startsWith('  '))
    .map(l => l.trim())
)

// i18n bundles: the closure stops at `@/i18n`, so add the en + zh catalogs,
// the runtime, and their type fragments by hand. Only en + zh — the host ships
// two languages (AGENTS.md rule 2).
const I18N = UP + 'i18n/'
for (const name of readdirSync(I18N)) {
  if (!/\.(ts|tsx)$/.test(name)) continue
  if (!/^(en|zh|types|define-locale|intro-zh|catalog|context|runtime|registry|languages|localized-tab-title)/.test(name)) continue
  files.add('i18n/' + name)
}

// Types + the two lib modules the type contract needs but the closure can't
// reach (it stops at `@/types/hermes`, a host boundary).
files.add('types/hermes.ts')
files.add('lib/tool-result-metadata.ts')

// Stylesheets: `import './x.css'` side effects are invisible to the
// from-clause matcher for files reached only through JSX className usage.
for (const css of [
  'app/capabilities/catalog/catalog.css',
  'app/capabilities/catalog/catalog-discovery.css',
  'app/capabilities/ui/page.css',
  'components/ui/masonry.css',
  'components/ui/tooltip.css'
]) {
  files.add(css)
}

const copied = []
const conflicts = []
const missing = []

function put(srcPath, destRel) {
  const destPath = join(DEST_ROOT, destRel)
  if (!existsSync(srcPath)) {
    missing.push(destRel)
    return
  }
  if (existsSync(destPath)) conflicts.push(destRel)
  if (!dryRun) {
    mkdirSync(dirname(destPath), { recursive: true })
    copyFileSync(srcPath, destPath)
  }
  copied.push(destRel)
}

for (const rel of files) {
  if (rel.startsWith('..')) continue // shared handled below
  put(UP + rel, rel)
}

// The shared workspace package: self-contained pure TS + one JSON, so the whole
// package is mirrored rather than guessed at file by file.
for (const name of readdirSync(SHARED)) {
  if (!/\.(ts|json)$/.test(name)) continue
  if (/\.test(-d)?\.ts$/.test(name)) continue
  put(SHARED + name, 'shared/' + name)
}

const report = [
  `source files = ${files.size}`,
  `copied       = ${copied.length}`,
  `conflict     = ${conflicts.length}`,
  `missing      = ${missing.length}`,
  '',
  '--- conflicts ---',
  ...conflicts.sort(),
  '',
  '--- missing upstream ---',
  ...missing.sort()
].join('\n')

writeFileSync(reportFile, report, 'utf8')
console.log(report.split('\n').slice(0, 4).join('\n'))
