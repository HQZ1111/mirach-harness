import { readFileSync, writeFileSync } from 'node:fs'

const t = readFileSync('src/hermes-mirror/lib/mcp-dashboard-oauth.ts', 'utf8')
const i = t.indexOf('bridge.mcpOauth')
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/oauth.txt', t.slice(Math.max(0, i - 600), i + 1600), 'utf8')
console.log('dumped', i)
