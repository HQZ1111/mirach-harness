// Render a DOM element's pixels as ASCII art. This is the ground truth that
// does not depend on any image viewer: dark pixels become '#', light become '.'.
const PORT = process.env.CDP_PORT || '9223'
const needle = process.argv[2] ?? 'Zz Smoke Test'

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

const shot = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
  clip: { ...clip, scale: 1 }
})
const dataUrl = 'data:image/png;base64,' + shot.data

const art = await send('Runtime.evaluate', {
  expression: `(async () => {
    const img = new Image(); img.src = ${JSON.stringify(dataUrl)}; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    const rows = []
    const STEP = 2
    for (let y = 0; y < c.height; y += STEP) {
      let line = ''
      for (let x = 0; x < c.width; x += STEP) {
        const i = (y * c.width + x) * 4
        const lum = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]
        line += lum < 80 ? '#' : lum < 170 ? '+' : lum < 240 ? '.' : ' '
      }
      rows.push(line)
    }
    return rows.join('\\n')
  })()`,
  awaitPromise: true,
  returnByValue: true
})
console.log(`element: ${JSON.stringify(needle)}  box: ${JSON.stringify(clip)}`)
console.log(art.result.value)
ws.close()
