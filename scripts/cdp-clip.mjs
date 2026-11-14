// Screenshot a CLIPPED region (default: the capabilities host) at 1x, so the
// image is small enough to inspect directly.
import { writeFileSync } from 'node:fs'

const PORT = process.env.CDP_PORT || '9223'
const out = process.argv[2]
const selector = process.argv[3] ?? '.hermes-capabilities-host'

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
const t = list.filter(x => x.type === 'page')[0]
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

const box = await send('Runtime.evaluate', {
  expression: `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'null'; const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }) })()`,
  returnByValue: true
})
const clip = JSON.parse(box.result.value)
console.log('clip', clip)

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
  clip: { ...clip, scale: 1 }
})
const buf = Buffer.from(shot.data, 'base64')
writeFileSync(out, buf)
console.log('wrote', out, buf.length, 'bytes', buf.readUInt32BE(16) + 'x' + buf.readUInt32BE(20))
ws.close()
