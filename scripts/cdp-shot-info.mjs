// Capture a screenshot and report the pixel colours at given points, so
// "is it blank" is answered by numbers rather than by eye.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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
const info = await send('Runtime.evaluate', {
  expression: `JSON.stringify({ dpr: devicePixelRatio, vw: innerWidth, vh: innerHeight, sw: screen.width, sh: screen.height })`,
  returnByValue: true
})
console.log('viewport', info.result.value)

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
const buf = Buffer.from(shot.data, 'base64')
const out = join(tmpdir(), 'shot.png')
writeFileSync(out, buf)
console.log('bytes', buf.length, '->', out)

// Decode PNG dimensions from the IHDR chunk (no deps).
const w = buf.readUInt32BE(16)
const h = buf.readUInt32BE(20)
console.log('png', w + 'x' + h)
ws.close()
