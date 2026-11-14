import { readFileSync, writeFileSync } from 'node:fs'

const t = readFileSync('src/hermes-mirror/i18n/context.tsx', 'utf8')
const i = t.indexOf('getMachineProfile')
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/i18nctx.txt', t.slice(Math.max(0, i - 400), i + 400), 'utf8')
console.log('at', i)
