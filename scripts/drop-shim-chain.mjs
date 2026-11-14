import { existsSync, rmSync } from 'node:fs'

for (const p of ['src/hermes-shim/store/activity.ts', 'src/hermes-shim/components/error-boundary.tsx']) {
  if (existsSync(p)) {
    rmSync(p, { force: true })
    console.log('removed', p)
  } else {
    console.log('absent', p)
  }
}
