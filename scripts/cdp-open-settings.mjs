// Open the settings window via IPC and time how long until it is a live target.
const PORT = process.env.CDP_PORT || '9223'

async function targets() {
  return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
}

const before = await targets()
console.log('targets before:', before.map(t => t.url))

// Drive the IPC from the main window.
const main = before[0]
const ws = new WebSocket(main.webSocketDebuggerUrl)
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
const t0 = Date.now()
const r = await send('Runtime.evaluate', {
  expression: `window.__TAURI_INTERNALS__.invoke('pi_open_settings_window').then(()=>'opened').catch(e=>'ERR '+e)`,
  awaitPromise: true,
  returnByValue: true
})
console.log('IPC result:', r.result.value, 'in', Date.now() - t0, 'ms')
ws.close()

// Poll for the new target.
for (let i = 0; i < 60; i++) {
  await new Promise(r => setTimeout(r, 250))
  const now = await targets()
  const extra = now.filter(t => !before.some(b => b.id === t.id))
  if (extra.length) {
    console.log(`new target after ${Date.now() - t0}ms:`, extra.map(t => t.url))
    break
  }
  if (i === 59) console.log('no new target after 15s')
}
