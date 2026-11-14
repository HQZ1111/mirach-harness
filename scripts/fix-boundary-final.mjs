import { readFileSync, writeFileSync } from 'node:fs'

const p = 'scripts/hermes-boundary-final.mjs'
let t = readFileSync(p, 'utf8')
// The layout adapter's doc comment contained `hermes-shim-fill.mjs` in
// backticks — inside the template literal that carries the file body, which
// terminated the string early (SyntaxError).
t = t.replace('one `hermes-shim-fill.mjs store/layout` away', 'one hermes-shim-fill.mjs run away')
writeFileSync(p, t, 'utf8')
console.log('nested backtick removed =', !t.includes('`hermes-shim-fill.mjs store/layout`'))
