import { readFileSync, writeFileSync } from 'node:fs'

const t = readFileSync('D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/store/agent-plugins.ts', 'utf8')
const i = t.indexOf('export interface AgentPluginScanFinding')
const j = t.indexOf('export async function updateAgentPlugin')
writeFileSync('C:/Users/Administrator/AppData/Local/Temp/apshapes.txt', t.slice(i, j), 'utf8')
console.log('extracted', j - i, 'chars')
