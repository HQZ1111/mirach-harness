// Precise audit: strip import/export-from statements via the TypeScript AST (not
// by line), so multi-line import blocks do not count as code deviations.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ts from 'typescript'

const MIRROR = 'src/hermes-mirror'
const DESKTOP = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src'

function walk(d, a = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    const s = statSync(p)
    if (s.isDirectory()) walk(p, a)
    else if (/\.(ts|tsx)$/.test(n)) a.push(p)
  }
  return a
}

/** Source with every module-specifier statement removed, whitespace-normalised. */
function bodyOnly(text) {
  const sf = ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const spans = []
  for (const st of sf.statements) {
    const isImport = ts.isImportDeclaration(st)
    const isExportFrom = ts.isExportDeclaration(st) && st.moduleSpecifier !== undefined
    if (isImport || isExportFrom) spans.push([st.getStart(sf), st.getEnd()])
  }
  let out = ''
  let cursor = 0
  for (const [s, e] of spans) {
    out += text.slice(cursor, s)
    cursor = e
  }
  out += text.slice(cursor)
  // Comments are host documentation, not behaviour — drop line/block comments.
  out = out.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  return out.replace(/\s+/g, ' ').trim()
}

const rows = []
// 有意的偏差：这些文件**已知**与上游不同，理由是宿主边界或上游缺口。
// 列在这里是为了让 DEV 计数保持"意外漂移 = 0"的判据——新增 DEV 必须
// 在这里登记并写明原因，否则说明有人手改了镜像（那是 bug 来源）。
const INTENTIONAL_DEV = new Map([
  // 上游所有中文 catalog 都缺整段 connectorsPage（207 键），按 AGENTS.md
  // 规矩 1 的 i18n 三件套例外补齐。
  ['i18n/zh.ts', '上游缺 connectorsPage 整段（i18n 例外补齐）'],
  // 上游 677 行完整 shadcn sidebar（Provider/折叠/mobile/Sheet）；定时任务
  // 侧栏区只用 SidebarGroup + SidebarGroupContent 两个纯 div 包装，实现逐字
  // 照抄、其余导出裁剪（与 beui 组件的裁剪口径同一条规矩）。
  ['components/ui/sidebar.tsx', '裁剪副本：只留 cron 侧栏区用到的两个导出'],
  // 上游 83 行，解决多后端 registry 拓扑下的 owner 路由。宿主只有一个进程内
  // 引擎，拓扑概念不存在，按边界口径重写（类型与判定函数形状保留）。
  ['store/session-owner-resolution.ts', '多后端拓扑在宿主不存在（唯一引擎）'],
])

for (const f of walk(MIRROR)) {
  const rel = f.slice(MIRROR.length + 1).replace(/\\/g, '/')
  let d
  try {
    d = readFileSync(join(DESKTOP, rel), 'utf8')
  } catch {
    rows.push(['HOST-ONLY', rel])
    continue
  }
  const same = bodyOnly(readFileSync(f, 'utf8')) === bodyOnly(d)
  if (same) {
    rows.push(['SAME', rel])
  } else if (INTENTIONAL_DEV.has(rel)) {
    // 已登记的有意偏差：单独计数，不计入"意外漂移"
    rows.push(['INTENTIONAL', rel])
  } else {
    rows.push(['DEV', rel])
  }
}

const dev = rows.filter(r => r[0] === 'DEV')
const same = rows.filter(r => r[0] === 'SAME')
const intentional = rows.filter(r => r[0] === 'INTENTIONAL')
const hostOnly = rows.filter(r => r[0] === 'HOST-ONLY')

const out = [
  `SAME: ${same.length}   INTENTIONAL: ${intentional.length}   DEV: ${dev.length}   HOST-ONLY: ${hostOnly.length}`,
  '',
  '--- INTENTIONAL (registered deviations) ---',
  ...intentional.map(r => `  ${r[1]}  —  ${INTENTIONAL_DEV.get(r[1])}`),
  '',
  '--- DEV (UNEXPECTED code differences — investigate) ---',
  ...dev.map(r => '  ' + r[1])
]
writeFileSync(join(tmpdir(), 'mirror-audit2.txt'), out.join('\n'), 'utf8')
console.log(out.slice(0, 3).join('\n'))

