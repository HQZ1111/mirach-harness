// Click a tab inside the capabilities host by its visible label, wait, shoot.
const PORT = process.env.CDP_PORT || '9223'
const label = process.argv[2]
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

const click = `(() => {
  const host = document.querySelector('.hermes-capabilities-host')
  if (!host) return JSON.stringify({ ok:false, why:'no host' })
  const tabs = [...host.querySelectorAll('button')].filter(b => (b.textContent||'').trim().startsWith(${JSON.stringify(label)}))
  if (!tabs.length) return JSON.stringify({ ok:false, why:'no tab', have:[...host.querySelectorAll('button')].map(b=>(b.textContent||'').trim().slice(0,14)).slice(0,12) })
  tabs[0].click()
  return JSON.stringify({ ok:true, label: (tabs[0].textContent||'').trim() })
})()`
const r = await send('Runtime.evaluate', { expression: click, returnByValue: true, userGesture: true })
console.log(r.result?.value)

await new Promise(res => setTimeout(res, 2500))

if (out) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log('wrote ' + out)
}

const text = await send('Runtime.evaluate', {
  expression: `(() => { const h=document.querySelector('.hermes-capabilities-host'); return h ? (h.innerText||'').slice(0,700) : 'NO HOST' })()`,
  returnByValue: true
})
console.log('--- TEXT ---')
console.log(text.result?.value)
ws.close()
