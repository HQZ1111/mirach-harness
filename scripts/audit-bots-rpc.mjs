// 穷举审计：hermes-bots 插件调用的每一个 RPC 方法 → 宿主是否接了
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const PLUGIN_DIR = 'G:/mirach-harness/src/hermes-mirror/plugins/hermes-bots'
const HOST_RPC = 'G:/mirach-harness/src/sdk/host-rpc.ts'
const HOST_TS = 'G:/mirach-harness/src/sdk/host.ts'

// 1) 从插件源码里抓所有 host.request('method') / host.requestProfile(route, 'method') 的方法名
const pluginFiles = []
function walk(dir) {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, f.name)
    if (f.isDirectory()) walk(full)
    else if (f.name.endsWith('.ts') || f.name.endsWith('.tsx')) pluginFiles.push(full)
  }
}
walk(PLUGIN_DIR)

const rpcCalls = new Set()
const hostApiCalls = new Set()
for (const file of pluginFiles) {
  const text = readFileSync(file, 'utf8')
  // host.request<T>('method', ...) or host.request('method', ...)
  for (const match of text.matchAll(/host\.request(?:<[^>]*>)?\(\s*['"]([^'"]+)['"]/g)) {
    rpcCalls.add(match[1])
  }
  // host.requestProfile(route, 'method', ...)
  for (const match of text.matchAll(/requestProfile[^,]+,\s*['"]([^'"]+)['"]/g)) {
    rpcCalls.add(match[1])
  }
  // host.xxx( — capture host API surface methods (not request/requestProfile)
  for (const match of text.matchAll(/host\.([a-zA-Z_]+)\s*[({]/g)) {
    const name = match[1]
    if (!['request', 'requestProfile', 'notify', 'notifyError', 'onEvent'].includes(name)) {
      hostApiCalls.add(name)
    }
  }
}

// 2) 从宿主 host-rpc.ts 抓所有 case 'method'
const rpcText = readFileSync(HOST_RPC, 'utf8')
const handledRpcs = new Set()
for (const match of rpcText.matchAll(/case\s+'([^']+)'/g)) {
  handledRpcs.add(match[1])
}

// 3) 从宿主 host.ts 抓所有暴露的 API 方法名
const hostText = readFileSync(HOST_TS, 'utf8')
const hostApiMethods = new Set()
for (const match of hostText.matchAll(/^\s{2}(\w+):\s*(?:async\s*)?(?:\(|[^,])/gm)) {
  hostApiMethods.add(match[1])
}

// 4) 交叉比对
const unhandledRpcs = [...rpcCalls].filter(m => !handledRpcs.has(m)).sort()
const missingHostApi = [...hostApiCalls].filter(m => !hostApiMethods.has(m)).sort()

console.log('=== 插件调用的 RPC 方法（去重）===')
console.log([...rpcCalls].sort().join('\n'))
console.log(`\n共 ${rpcCalls.size} 个 RPC 方法`)
console.log(`\n=== 宿主未接的 RPC（插件调了但 host-rpc 没有 case）===`)
console.log(unhandledRpcs.length ? unhandledRpcs.join('\n') : '（无）')
console.log(`\n=== 插件用的 host API 方法 ===`)
console.log([...hostApiCalls].sort().join(', '))
console.log(`\n=== 宿主 host.ts 缺的 API ===`)
console.log(missingHostApi.length ? missingHostApi.join('\n') : '（无）')
