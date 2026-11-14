// Click an element by aria-label / text via real input dispatch.
const PORT = process.env.CDP_PORT || '9223'
const want = process.argv[2]

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

const expr = `(() => {
  const want = ${JSON.stringify(want)}
  const els = [...document.querySelectorAll('button,[role=button],[role=tab],a')]
  const el = els.find(e => (e.getAttribute('aria-label')||'').trim() === want)
    || els.find(e => (e.textContent||'').trim() === want)
    || els.find(e => (e.getAttribute('aria-label')||'').includes(want))
    || els.find(e => (e.textContent||'').includes(want))
  if (!el) return JSON.stringify({ ok:false, tried: els.length })
  el.click()
  return JSON.stringify({ ok:true, tag: el.tagName, label: el.getAttribute('aria-label'), text:(el.textContent||'').trim().slice(0,40) })
})()`

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, userGesture: true })
console.log(r.result?.value ?? JSON.stringify(r))
ws.close()
