import { readFileSync, writeFileSync } from 'node:fs'

const text = readFileSync(process.argv[2], 'utf8')
const files = text
  .split('--- boundary')[0]
  .split(/\r?\n/)
  .filter(l => l.startsWith('  '))
  .map(l => l.trim())

const SRC = 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/'
const SHARED = 'D:/新建文件夹 (5)/hermes-agent-main/apps/shared/src/'

let total = 0
const byDir = {}
const rows = []
for (const f of files) {
  const p = f.startsWith('..') ? SHARED + f.split('/').pop() : SRC + f
  let n = 0
  try {
    n = readFileSync(p, 'utf8').split(/\r?\n/).length
  } catch {
    n = -1
  }
  rows.push(`${String(n).padStart(6)}  ${f}`)
  total += Math.max(n, 0)
  const d = f.startsWith('..') ? 'SHARED' : f.split('/').slice(0, 2).join('/')
  byDir[d] = (byDir[d] || 0) + Math.max(n, 0)
}

let out = `total lines = ${total}\n\n`
for (const k of Object.keys(byDir).sort((a, b) => byDir[b] - byDir[a])) {
  out += `${String(byDir[k]).padStart(7)}  ${k}\n`
}
out += '\n--- per file ---\n' + rows.join('\n')
writeFileSync(process.argv[3], out, 'utf8')
console.log('ok')
