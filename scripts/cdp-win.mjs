// Evaluate an expression in a specific window by URL substring.
const PORT = process.env.CDP_PORT || '9223'
const match = process.argv[2] ?? ''
const expr = process.argv[3] ?? 'location.href'

const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
const t = list.find(x => match === '' ? !x.url.includes('win=') : x.url.includes(match))
if (!t) {
  console.log('no target matching ' + JSON.stringify(match), 'available:', list.map(x => x.url))
  process.exit(1)
}

const ws = new WebSocket(t.webSocketDebuggerUrl)
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
const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
console.log(r.result?.value ?? JSON.stringify(r.exceptionDetails ?? r))
ws.close()
