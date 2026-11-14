// Inspect the settings window: how long until content exists, and what the
// first paint looks like (background colour of html/body/#root).
const PORT = process.env.CDP_PORT || '9223'

const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(t => t.type === 'page')
const win = list.find(t => t.url.includes('win=settings'))
if (!win) {
  console.log('settings window not open')
  process.exit(1)
}

const ws = new WebSocket(win.webSocketDebuggerUrl)
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

const probe = `(() => {
  const cs = el => el ? getComputedStyle(el).backgroundColor : 'n/a'
  const root = document.getElementById('root')
  const nav = performance.getEntriesByType('navigation')[0]
  const paints = performance.getEntriesByType('paint').map(p => ({ name: p.name, start: Math.round(p.startTime) }))
  return JSON.stringify({
    now: Math.round(performance.now()),
    domContentLoaded: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
    loadEvent: nav ? Math.round(nav.loadEventEnd) : null,
    paints,
    resources: performance.getEntriesByType('resource').length,
    srcModules: performance.getEntriesByType('resource').filter(r => r.name.includes('/src/')).length,
    rootChildren: root ? root.childElementCount : -1,
    rootHTMLHead: root ? root.innerHTML.slice(0, 120) : 'no root',
    bg: { html: cs(document.documentElement), body: cs(document.body), root: cs(root) },
    hasSetRoot: !!document.querySelector('.settings-window-root')
  })
})()`

const r = await send('Runtime.evaluate', { expression: probe, returnByValue: true })
console.log(JSON.stringify(JSON.parse(r.result.value), null, 2))
ws.close()
