// Crop the box of a specific element and report an "ink census": how many
// pixels are dark (text), plus the crop's own PNG. Numbers first, image second.
import { writeFileSync } from 'node:fs'

const PORT = process.env.CDP_PORT || '9223'
const needle = process.argv[2] ?? 'Zz Smoke Test'
const out = process.argv[3]

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

const boxRes = await send('Runtime.evaluate', {
  expression: `(() => {
    const el = [...document.querySelectorAll('*')].find(e => (e.textContent||'').trim() === ${JSON.stringify(needle)})
    if (!el) return 'null'
    const r = el.getBoundingClientRect()
    return JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) })
  })()`,
  returnByValue: true
})
const clip = JSON.parse(boxRes.result.value)
console.log('element box', clip)

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
  clip: { ...clip, scale: 2 }
})
const dataUrl = 'data:image/png;base64,' + shot.data
if (out) {
  const buf = Buffer.from(shot.data, 'base64')
  writeFileSync(out, buf)
  console.log('wrote', out, buf.readUInt32BE(16) + 'x' + buf.readUInt32BE(20))
}

const census = await send('Runtime.evaluate', {
  expression: `(async () => {
    const img = new Image(); img.src = ${JSON.stringify(dataUrl)}; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let dark = 0, mid = 0, light = 0, total = c.width * c.height
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]
      if (lum < 100) dark++
      else if (lum < 220) mid++
      else light++
    }
    return JSON.stringify({ size: [c.width, c.height], total, darkPct: +(100*dark/total).toFixed(2), midPct: +(100*mid/total).toFixed(2), lightPct: +(100*light/total).toFixed(2) })
  })()`,
  awaitPromise: true,
  returnByValue: true
})
console.log('ink census', census.result.value)
ws.close()
