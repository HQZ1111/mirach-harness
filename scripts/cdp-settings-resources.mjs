// What does the SETTINGS window actually load? Group its resources by area so we
// can see whether it drags in the main-window app graph (dockview/chat/etc).
const PORT = process.env.CDP_PORT || '9223'

const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
const win = list.find(t => t.url.includes('win=settings'))
if (!win) {
  console.log('settings window not open')
  process.exit(1)
}

const ws = new WebSocket(win.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})
let id = 0
const pending = new Map()
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })

await send('Runtime.enable')

const expr = `(() => {
  const rs = performance.getEntriesByType('resource').map(r => r.name)
  const src = rs.filter(n => n.includes('/src/'))
  const groups = {}
  for (const n of src) {
    const m = n.match(/\\/src\\/([^/?]+)/)
    const top = m ? m[1] : 'other'
    groups[top] = (groups[top] || 0) + 1
  }
  const marks = {
    dockview: src.some(n => n.includes('dockview')),
    assistantUi: src.some(n => n.includes('assistant-ui')),
    thread: src.some(n => n.includes('thread.')),
    hermesMirror: src.filter(n => n.includes('hermes-mirror')).length,
    hermesShim: src.filter(n => n.includes('hermes-shim')).length,
    settings: src.filter(n => n.includes('/settings')).length,
    nodeModules: rs.filter(n => n.includes('/node_modules/.vite/deps/')).length
  }
  const total = src.length
  return JSON.stringify({ totalSrcModules: total, groups, marks }, null, 1)
})()`

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
console.log(r.result.value)
ws.close()
