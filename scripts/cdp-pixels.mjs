// Capture, then decode IN THE PAGE via canvas and sample pixels at DOM-derived
// coordinates. This answers "is anything painted" with numbers.
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
const shot = await send('Page.captureScreenshot', { format: 'png' })
const dataUrl = 'data:image/png;base64,' + shot.data

const expr = `(async () => {
  const img = new Image()
  img.src = ${JSON.stringify(dataUrl)}
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.width; c.height = img.height
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const px = (x, y) => { const d = ctx.getImageData(x, y, 1, 1).data; return [d[0],d[1],d[2]] }

  // distinct-colour census over a grid
  const seen = new Map()
  for (let y = 0; y < img.height; y += 8) {
    for (let x = 0; x < img.width; x += 8) {
      const [r,g,b] = px(x,y)
      const k = r+','+g+','+b
      seen.set(k, (seen.get(k)||0)+1)
    }
  }
  const top = [...seen.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8)

  // sample specific DOM boxes
  const boxes = {}
  const host = document.querySelector('.hermes-capabilities-host')
  if (host) {
    const r = host.getBoundingClientRect()
    boxes.hostTL = px(Math.round(r.left)+6, Math.round(r.top)+6)
    boxes.hostMid = px(Math.round(r.left + r.width/2), Math.round(r.top + r.height/2))
  }
  const row = [...document.querySelectorAll('*')].find(e => (e.textContent||'').trim() === 'Zz Smoke Test')
  if (row) {
    const r = row.getBoundingClientRect()
    boxes.rowCenter = px(Math.round(r.left + 6), Math.round(r.top + r.height/2))
  }
  return JSON.stringify({ size: [img.width, img.height], distinctColours: seen.size, top, boxes }, null, 1)
})()`

const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
console.log(r.result?.value ?? JSON.stringify(r.exceptionDetails))
ws.close()
