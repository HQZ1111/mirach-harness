import { writeFileSync } from 'node:fs'

writeFileSync('src/hermes-mirror/shared/billing.ts', "export * from './billing-types'\n", 'utf8')
console.log('billing.ts recreated')
