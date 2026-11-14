// Reload the page with console + exceptions captured, then dump the first
// runtime error with its stack.
const PORT = process.env.CDP_PORT || '9223'

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const t = list.filter(x => x.type === 'page')[0]
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = rej
})

let id = 0
const pending = new Map()
const events = []
ws.onmessage = ev => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  } else if (msg.method) {
    events.push(msg)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const mid = ++id
    pending.set(mid, { resolve, reject })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')
await send('Page.reload', { ignoreCache: true })
await new Promise(r => setTimeout(r, 6000))

const errs = []
for (const e of events) {
  if (e.method === 'Runtime.exceptionThrown') {
    const d = e.params.exceptionDetails
    errs.push({
      kind: 'exception',
      text: d.text,
      desc: d.exception?.description,
      stack: d.stackTrace?.callFrames?.slice(0, 12).map(f => `${f.functionName || '<anon>'} ${f.url}:${f.lineNumber + 1}:${f.columnNumber + 1}`)
    })
  }
  if (e.method === 'Runtime.consoleAPICalled' && (e.params.type === 'error' || e.params.type === 'warning')) {
    errs.push({
      kind: e.params.type,
      text: e.params.args.map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 800)
    })
  }
}
console.log(JSON.stringify(errs.slice(0, 12), null, 2))
ws.close()
