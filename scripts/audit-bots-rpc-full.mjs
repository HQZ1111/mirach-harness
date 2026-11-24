// 更全面的审计：抓所有 RPC 调用形态 + host-rpc case 全集 + 直接 invoke 命令
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PLUGIN_DIR = 'G:/mirach-harness/src/hermes-mirror/plugins/hermes-bots'
const HOST_RPC = 'G:/mirach-harness/src/sdk/host-rpc.ts'

const pluginFiles = []
function walk(dir) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, f.name)
    if (f.isDirectory()) walk(full)
    else if (f.name.endsWith('.ts') || f.name.endsWith('.tsx')) pluginFiles.push(full)
  }
}
walk(PLUGIN_DIR)

// 1) 插件里所有字符串字面量里含 . 的方法名（xxx.yyy 形态——所有 RPC 方法都是 namespaced）
const rpcPatterns = new Set()
for (const file of pluginFiles) {
  const text = readFileSync(file, 'utf8')
  // 匹配引号内的 namespaced 方法名
  for (const match of text.matchAll(/['"]((?:bot_relay|cli|cron|display|groups|image|pet|profiles|prompt|session|skills|mcp|model|setup|tool|approval|task|message|gateway|composer|chat|sidebar|command|host)\.[a-zA-Z_.]+)['"]/g)) {
    rpcPatterns.add(match[1])
  }
}

// 2) 宿主 host-rpc.ts 的 case 全集 + Rust groups_dispatch 的方法全集
const rpcText = readFileSync(HOST_RPC, 'utf8')
const handledRpcs = new Set()
for (const match of rpcText.matchAll(/case\s+'([^']+)'/g)) {
  handledRpcs.add(match[1])
}

// 3) Rust pi_groups.rs 的方法（groups_dispatch 分派）
const groupsText = readFileSync('G:/mirach-harness/src-tauri/src/pi_groups.rs', 'utf8')
const groupMethods = new Set()
for (const match of groupsText.matchAll(/"((?:groups|bot_relay)\.[a-zA-Z_.]+)"/g)) {
  groupMethods.add(match[1])
}

// 4) 宿主直接 invoke 的命令（从插件里抓）
const invokeCmds = new Set()
for (const file of pluginFiles) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/invoke\(\s*['"]([^'"]+)['"]/g)) {
    invokeCmds.add(match[1])
  }
}

// 5) 交叉
const unhandled = [...rpcPatterns].filter(m => !handledRpcs.has(m) && !groupMethods.has(m)).sort()

console.log(`=== 插件调用的 RPC 方法名（namespaced，去重 ${rpcPatterns.size} 个）===`)
console.log([...rpcPatterns].sort().join('\n'))
console.log(`\n=== 宿主 host-rpc case 全集（${handledRpcs.size} 个）===`)
console.log([...handledRpcs].sort().join('\n'))
console.log(`\n=== Rust groups_dispatch 方法全集（${groupMethods.size} 个）===`)
console.log([...groupMethods].sort().join('\n'))
console.log(`\n=== ❌ 未接的 RPC（插件调了但两边都没有 case）===`)
console.log(unhandled.length ? unhandled.join('\n') : '（无）')
console.log(`\n=== 插件直接 invoke 的命令（不走 host-rpc）===`)
console.log([...invokeCmds].sort().join('\n'))
