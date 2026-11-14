// Cluster 1 fix: the mirrored pane-shell tree store consumes the REAL upstream
// interface-mode layout-persistence API (`modeLayout.atom/.mode/.restoring/
// .write/.has/.onRestore`) plus `modeBound`. A narrow host adapter cannot
// satisfy that without re-inventing the file, so the pure upstream modules are
// copied verbatim into the shim (the shim is where upstream pure code lives —
// see docs/HANDOFF-hermes-port.md). Every one of these files depends only on
// persisted/storage/layout-persistence, which are already mirrored.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SRC = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src'
const SHIM = 'src/hermes-shim'

const files = [
  'store/interface-mode.ts',
  'store/panes.ts',
  'store/tool-view.ts',
  'store/reasoning-disclosure.ts',
  'store/statusbar-prefs.ts'
]

for (const rel of files) {
  const to = join(SHIM, rel)
  mkdirSync(dirname(to), { recursive: true })
  copyFileSync(join(SRC, rel), to)
  console.log('copied', rel)
}

// The pane-shell barrel is a one-constant module upstream; the mirrored tree
// store's siblings import the event name from it.
const barrel = join('src/hermes-mirror/components/pane-shell', 'index.ts')
mkdirSync(dirname(barrel), { recursive: true })
copyFileSync(join(SRC, 'components/pane-shell/index.ts'), barrel)
console.log('copied components/pane-shell/index.ts')

// windows.ts: upstream interface-mode asks isHudWindow() at module scope.
const winPath = join(SHIM, 'store/windows.ts')
const win = readFileSync(winPath, 'utf8')
if (!win.includes('isHudWindow')) {
  writeFileSync(
    winPath,
    win.trimEnd() +
      `

/** Upstream mounts the HUD as its own window kind. The host's ?win=hud branch is
 *  not wired (AGENTS.md: main.tsx keeps three branches, hud not implemented), so
 *  no window is ever the HUD. */
export function isHudWindow(): boolean {
  return false
}
`,
    'utf8'
  )
  console.log('patched store/windows.ts (isHudWindow)')
}
