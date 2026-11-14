// ZCode 移植全链路实机验证（第二轮，2026-11-01）：
//   A. 面板栏：打开页无标签（:has 隐藏条）+ 末签关闭 = 关栏 + 重开 = launcher
//   B. 状态面板：进程/终端（含已退出）/智能体（含已结束）/git（含分支切换器）
//   C. 文件夹位置 chip：输入框上方（卡外）+ 菜单 side=top
const PORT = process.env.CDP_PORT || '9223'
const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(
  (t) => t.type === 'page' && !t.url.includes('win='),
)
const ws = new WebSocket(list[0].webSocketDebuggerUrl)
await new Promise((r, j) => {
  ws.onopen = r
  ws.onerror = () => j(new Error('ws'))
})
let id = 0
const pend = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pend.has(m.id)) {
    const p = pend.get(m.id)
    pend.delete(m.id)
    m.error ? p.j(new Error(JSON.stringify(m.error))) : p.r(m.result)
  }
}
const send = (method, params = {}) =>
  new Promise((r, j) => {
    const mid = ++id
    pend.set(mid, { r, j })
    ws.send(JSON.stringify({ id: mid, method, params }))
  })
await send('Runtime.enable')
await send('Page.enable')
const ev = async (x) => {
  const r = await send('Runtime.evaluate', {
    expression: x,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result?.value
}
const { writeFileSync } = await import('node:fs')
const OUT = process.env.TEMP + '\\mirach-zcode2'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const shot = async (name, clip) => {
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 2 } })
  const file = `${OUT}-${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log(`shot ${name}: ${file} clip=${JSON.stringify(clip)}`)
}
const click = (sel) =>
  ev(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return 'absent'; el.click(); return 'clicked' })()`)

// ── A. 面板栏 ────────────────────────────────────────────────────────
console.log('── A. 面板栏生命周期 ──')
const panelState = await ev(`(() => {
  const a = globalThis.__dvApi
  if (!a) return { error: 'no __dvApi' }
  const panels = a.panels.filter(p => p.params?.region === 'panels').map(p => p.id)
  const stripForLauncher = document.querySelector('.dv-tabs-and-actions-container:has(.dv-open-tab-title)')
  return {
    panelIds: panels,
    panelsHiddenFlag: localStorage.getItem('mirach.harness.layout.colflags.v1'),
    launcherStripDisplay: stripForLauncher ? getComputedStyle(stripForLauncher).display : '(no launcher strip)',
  }
})()`)
console.log('  初始态：', JSON.stringify(panelState))

// A1: 若面板栏有实签 → 逐个关闭到空（验证末签关闭 = 关栏）
const closeRealTabs = async () => {
  for (let i = 0; i < 6; i++) {
    const r = await ev(`(() => {
      const a = globalThis.__dvApi
      const real = a.panels.find(p => p.params?.region === 'panels' && p.id !== 'open')
      if (!real) return 'empty'
      const strip = real.group.headers?.hidden
      real.api.close()
      return 'closed ' + real.id
    })()`)
    if (r === 'empty') return true
    await sleep(500)
  }
  return false
}
const emptied = await closeRealTabs()
await sleep(800)
const afterClose = await ev(`(() => {
  const a = globalThis.__dvApi
  const flags = JSON.parse(localStorage.getItem('mirach.harness.layout.colflags.v1') || '{}')
  const pg = a.groups.find(g => g.panels.some(p => p.params?.region === 'panels'))
  return {
    panelsRegionGroup: pg ? pg.id : null,
    panelIds: a.panels.filter(p => p.params?.region === 'panels').map(p => p.id),
    panelsHiddenFlag: flags.panelsHidden,
    visibleWidth: pg ? Math.round(pg.width) : null,
  }
})()`)
console.log('  清空实签后：', JSON.stringify(afterClose))

// A2: 右键「打开面板栏」重新在场 → launcher 无标签
await ev(`(() => {
  const btn = [...document.querySelectorAll('[role="menuitem"], button')].find(b => b.textContent?.includes('打开面板栏'))
  if (!btn) return 'menu-item-absent'
  btn.click()
  return 'clicked'
})()`)
await sleep(1200)
const afterReopen = await ev(`(() => {
  const a = globalThis.__dvApi
  const pg = a.groups.find(g => g.panels.some(p => p.params?.region === 'panels'))
  const launcher = document.querySelector('[data-slot="open-page"]')
  const strip = document.querySelector('.dv-tabs-and-actions-container:has(.dv-open-tab-title)')
  const r = launcher?.getBoundingClientRect()
  return {
    group: pg?.id ?? null,
    width: pg ? Math.round(pg.width) : null,
    launcherVisible: Boolean(launcher && r && r.width > 50),
    stripDisplay: strip ? getComputedStyle(strip).display : '(strip absent)',
    panelIds: a.panels.filter(p => p.params?.region === 'panels').map(p => p.id),
  }
})()`)
console.log('  重开面板栏后：', JSON.stringify(afterReopen))
const lp = await ev(`(() => {
  const el = document.querySelector('[data-slot="open-page"]')
  const r = el.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height,
    items: [...el.querySelectorAll('[data-open-page-item]')].map(b => b.dataset.openPageItem) }
})()`)
console.log('  launcher 内容：', JSON.stringify(lp))
if (lp && !lp.error) {
  await shot('launcher', { x: lp.x, y: lp.y, width: lp.w, height: Math.min(lp.h, 800) })
}

// ── B. 状态面板 ──────────────────────────────────────────────────────
console.log('── B. 活动状态面板 ──')
const status = await ev(`(() => {
  const aside = document.querySelector('aside[data-display-mode]')
  if (!aside) return { error: '面板未渲染' }
  const r = aside.getBoundingClientRect()
  return {
    mode: aside.dataset.displayMode,
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    sections: [...aside.querySelectorAll('[data-status-section]')].map(s => s.dataset.statusSection),
    branchRow: Boolean(aside.querySelector('[aria-label="切换分支"]')),
  }
})()`)
console.log('  ', JSON.stringify(status, null, 2))
if (status && !status.error && status.rect.w > 0) {
  await shot('status-panel', { x: Math.max(0, status.rect.x - 12), y: Math.max(0, status.rect.y - 12), width: status.rect.w + 24, height: Math.min(status.rect.h + 24, 700) })
}

// ── C. 文件夹位置 chip ───────────────────────────────────────────────
console.log('── C. 文件夹位置 chip ──')
const chip = await ev(`(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const trigger = document.querySelector('[data-slot="workspace-composer-trigger"]')
  if (!trigger) return { error: 'chip 不在场（activeId 非 null？）' }
  const r = trigger.getBoundingClientRect()
  // 输入框卡片（ComposerBar）的位置——chip 必须在其上方（卡外）
  const bar = trigger.closest('[data-slot="composer-bar"]')
  const out = { chipRect: { x: r.x, y: r.y, w: r.width, h: r.height }, label: trigger.textContent }
  out.insideCard = Boolean(bar && bar.contains(trigger))
  if (bar) {
    const br = bar.getBoundingClientRect()
    out.aboveCard = r.bottom <= br.top + 1
  }
  trigger.click()
  await sleep(700)
  const menu = document.querySelector('[data-menu-portal]')
  const menuPanel = menu?.querySelector('[role="menu"]')
  if (menuPanel) {
    const mr = menuPanel.getBoundingClientRect()
    out.menuRect = { x: mr.x, y: mr.y, w: mr.width, h: mr.height }
    out.menuItems = [...menuPanel.querySelectorAll('[data-context-menu-item]')].map(b => b.textContent.trim().slice(0, 36))
    const search = menu.querySelector('input')
    out.hasSearch = Boolean(search)
    const tr = document.querySelector('[data-slot="workspace-composer-trigger"]').getBoundingClientRect()
    out.menuOpensUpward = mr.bottom <= tr.top + 1
  }
  return out
})()`)
console.log('  ', JSON.stringify(chip, null, 2))
if (chip && !chip.error) {
  if (chip.menuRect) {
    await shot('workspace-menu', {
      x: Math.max(0, chip.menuRect.x - 12),
      y: Math.max(0, chip.menuRect.y - 12),
      width: chip.menuRect.w + 24,
      height: Math.min(chip.menuRect.h + 80, 700),
    })
  } else {
    await shot('workspace-chip', { x: Math.max(0, chip.chipRect.x - 20), y: Math.max(0, chip.chipRect.y - 60), width: 400, height: 160 })
  }
  // 关菜单
  await ev(`document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); 'ok'`)
}

ws.close()
