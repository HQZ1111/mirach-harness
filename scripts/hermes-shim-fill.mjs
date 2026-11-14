// After the shim rebuild, re-copy the modules that the mirror reaches but the
// explicit VERBATIM list omitted. Kept as a separate step so the list stays the
// authority and this only fills genuine gaps (it never overwrites).
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const UP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const SHIM = 'src/hermes-shim/'
const EXTS = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']

const rels = process.argv.slice(2)
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
    console.log('MISS', rel)
    continue
  }
  const dest = SHIM + rel + src.slice(UP.length + rel.length)
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
  console.log('OK  ', rel + src.slice(UP.length + rel.length))
}
