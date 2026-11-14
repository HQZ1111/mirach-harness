// Minimal CDP driver: list targets, evaluate an expression, capture a
// screenshot. No deps — plain WebSocket via node's global WebSocket (Node 22+).
const PORT = process.env.CDP_PORT || '9223'

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  return res.json()
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = e => rej(new Error('ws error'))
  })
  let id = 0
  const pending = new Map()
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  return { ws, send }
}

const cmd = process.argv[2]

if (cmd === 'list') {
  const list = await targets()
  console.log(
    JSON.stringify(
      list.map(t => ({ id: t.id, type: t.type, title: t.title, url: t.url, ws: t.webSocketDebuggerUrl })),
      null,
      2
    )
  )
} else if (cmd === 'eval') {
  const expr = process.argv[3]
  const list = (await targets()).filter(t => t.type === 'page')
  const t = list[0]
  const { ws, send } = await connect(t.webSocketDebuggerUrl)
  await send('Runtime.enable')
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  })
  console.log(JSON.stringify(r.result?.value ?? r.exceptionDetails ?? r, null, 2))
  ws.close()
} else if (cmd === 'shot') {
  const out = process.argv[3]
  const list = (await targets()).filter(t => t.type === 'page')
  const t = list[0]
  const { ws, send } = await connect(t.webSocketDebuggerUrl)
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(out, Buffer.from(r.data, 'base64'))
  console.log('wrote ' + out)
  ws.close()
} else {
  console.log('usage: node cdp.mjs list | eval "<expr>" | shot <file>')
}
