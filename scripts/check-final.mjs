import { readFileSync, writeFileSync } from 'node:fs'

const body = readFileSync('scripts/hermes-shim-final-adapters.mjs', 'utf8')
console.log('final-adapters has layout entry:', body.includes(`'store/layout.ts'`))
