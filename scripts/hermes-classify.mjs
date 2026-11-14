// Classify every host-boundary module: does it touch the gateway/host at all?
// Pure modules can simply be mirrored (still byte-identical upstream code); only
// the ones that reach `window.hermesDesktop` or a store need a real adapter.
import { readFileSync } from 'node:fs'

const SRC = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const targets = process.argv.slice(2)
const rows = []
for (const t of targets) {
  let text = ''
  try {
    text = readFileSync(SRC + t, 'utf8')
  } catch {
    try {
      text = readFileSync(SRC + t + '.tsx', 'utf8')
    } catch {
      try {
        text = readFileSync(SRC + t + '.ts', 'utf8')
      } catch {
        rows.push([t, 'MISSING', ''])
        continue
      }
    }
  }
  const lines = text.split(/\r?\n/).length
  const host = /hermesDesktop|window\.api|ipcRenderer/.test(text) ? 'HOST' : ''
  const imports = [...text.matchAll(/(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g)].map(m => m[1])
  const crosses = imports.filter(
    s => s.startsWith('@/store/') || s === '@/hermes' || s.startsWith('@/api/') || s.startsWith('@/contrib/')
  )
  rows.push([t, host, crosses.join(' ')])
  void lines
}
for (const [t, host, crosses] of rows) {
  console.log(`${t.padEnd(34)} ${host.padEnd(5)} ${crosses}`)
}
