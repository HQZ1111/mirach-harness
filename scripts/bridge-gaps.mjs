import { readFileSync, writeFileSync } from 'node:fs'

const t = readFileSync('C:/Users/Administrator/AppData/Local/Temp/byN.txt', 'utf8')
const blocks = t.split(/\r?\n=== /).slice(1)
const props = new Set()
const other = []
for (const b of blocks) {
  const name = b.slice(0, b.indexOf('\n')).trim()
  if (!name.startsWith('src/hermes-shim')) continue
  for (const m of b.matchAll(/Property '([^']+)' does not exist on type '([^']+)'/g)) {
    if (m[2].includes('HermesDesktopBridge') || m[2].includes('Window')) props.add(m[1])
    else other.push(`${name}: ${m[0].slice(0, 110)}`)
  }
}
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/props.txt', [...props].sort().join('\n'), 'utf8')
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/other-props.txt', other.join('\n'), 'utf8')
console.log([...props].sort().join('\n'))
console.log('\n--- non-bridge property errors:', other.length)
