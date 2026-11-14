// Expand BOTH trees until every specifier they reach resolves to a real file.
//
// The mirror (`src/hermes-mirror`) holds upstream code verbatim; the shim
// (`src/hermes-shim`) holds the host boundary — but the boundary modules are
// upstream code too, so their own imports have to be pulled in as well.
// A file lands in the mirror when upstream has it and it is not on the boundary
// list; otherwise it lands in the shim.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, relative } from 'node:path'

const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const UP_SHARED = 'D:/新建文件夹 (5)/hermes-agent-main/apps/shared/src/'
const MIRROR = 'src/hermes-mirror'
const SHIM = 'src/hermes-shim'
const EXTS = ['', '.ts', '.tsx', '.css', '/index.ts', '/index.tsx']

// Modules that must be host adapters (never auto-copied), because they talk to
// the Electron main process / gateway.
const BOUNDARY = ['hermes.ts', 'global.d.ts', 'api/', 'contrib/', 'sdk/']

const isBoundary = rel => BOUNDARY.some(b => (b.endsWith('/') ? rel.startsWith(b) : rel === b))

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
  return acc
}

const resolveIn = (root, rel) => {
  for (const e of EXTS) {
    const p = join(root, rel + e)
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

const upResolve = rel => {
  for (const e of EXTS) {
    const p = UP + rel + e
    if (existsSync(p) && statSync(p).isFile()) return p
  }
  return null
}

const copied = []

for (let round = 0; round < 20; round++) {
  let progressed = false
  for (const file of [...walk(MIRROR), ...walk(SHIM)]) {
    const text = readFileSync(file, 'utf8')
    const specs = [
      ...[...text.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)].map(m => m[1]),
      ...[...text.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map(m => m[1])
    ]

    for (const spec of specs) {
      let rel = null
      let base = null
      if (spec.startsWith('@/hermes-mirror/')) {
        rel = spec.slice('@/hermes-mirror/'.length)
        base = MIRROR
      } else if (spec.startsWith('@/hermes-shim/')) {
        rel = spec.slice('@/hermes-shim/'.length)
        base = SHIM
      } else if (spec.startsWith('.')) {
        // Relative: keep it in the tree that owns the importing file.
        const abs = normalize(join(dirname(file), spec))
        const root = abs.includes('hermes-shim') ? SHIM : MIRROR
        rel = relative(root, abs).replace(/\\/g, '/')
        base = root
        // Relative import that resolves to nothing: look it up upstream under
        // the same path inside that tree.
        if (resolveIn(root, rel)) continue
      } else {
        continue
      }

      if (resolveIn(base, rel)) continue

      // Unresolved. Pull it from upstream, into the tree it was asked from.
      const up = upResolve(rel)
      if (!up) {
        // Shared workspace paths (`../../../shared/src/x`) map to the mirror's
        // `shared/` copy.
        const sharedName = rel.split('/').pop()
        const sharedUp = UP_SHARED + sharedName + '.ts'
        if (existsSync(sharedUp)) {
          const dest = join(MIRROR, 'shared', sharedName + '.ts')
          if (!existsSync(dest)) {
            mkdirSync(dirname(dest), { recursive: true })
            copyFileSync(sharedUp, dest)
            copied.push('shared/' + sharedName + '.ts')
            progressed = true
          }
        }
        continue
      }

      const upRel = relative(UP, up).replace(/\\/g, '/')
      const destRoot = isBoundary(upRel) || base === SHIM ? SHIM : MIRROR
      const dest = join(destRoot, upRel)
      if (existsSync(dest)) continue
      mkdirSync(dirname(dest), { recursive: true })
      copyFileSync(up, dest)
      copied.push((destRoot === SHIM ? 'shim/' : '') + upRel)
      progressed = true
    }
  }
  if (!progressed) break
}

writeFileSync('C:/Users/Administrator/AppData/Local/Temp/expand2.log', copied.sort().join('\n'), 'utf8')
console.log('copied', copied.length)
console.log(copied.sort().join('\n'))
