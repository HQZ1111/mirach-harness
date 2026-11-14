/**
 * 从 hermes 的 zh.ts **逐字抽取** capabilities 用到的文案段落，
 * 生成宿主可用的 TS 模块。
 *
 * 为什么用脚本而不是手抄：手抄会走样（第一版就抄错了 —— `refresh` 上游是
 * 「刷新技能」，我写成「刷新」；`appliesToNewSessions` 上游是
 * `name 将应用于新会话。`，我多加了书名号）。脚本按行区间原样切片，
 * 零改写。
 *
 * 用法：node scripts/extract-capabilities-copy.mjs
 */
import fs from 'node:fs'
import path from 'node:path'

const SRC_DIR = process.env.HERMES_I18N ?? 'D:/新建文件夹 (5)/hermes-agent-main/apps/desktop/src/i18n'
const SRC = path.join(SRC_DIR, 'zh.ts')
const SRC_CATALOG = path.join(SRC_DIR, 'zh_catalog.ts')
const OUT = 'src/components/panes/capabilities/capabilities-copy.zh.ts'

const lines = fs.readFileSync(SRC, 'utf8').split('\n')

/** 找一个顶层键（两个空格缩进）的起止行（1-based 行号）。 */
function section(name, fromLine = 0) {
  const startRe = new RegExp(`^  ${name}: \\{$`)
  let start = -1
  for (let i = fromLine; i < lines.length; i++) {
    if (startRe.test(lines[i])) {
      start = i
      break
    }
  }
  if (start < 0) throw new Error(`section not found: ${name}`)

  // 从 start 向下找到缩进回到 2 个空格的 `},`
  let depth = 0
  let end = -1
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    for (const ch of line) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    if (depth === 0 && i > start) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error(`section end not found: ${name}`)
  return { start, end }
}

/** 取 section 的原始文本，缩进减 2（从顶层降为对象属性）。 */
function slice(name) {
  const { start, end } = section(name)
  return lines
    .slice(start, end + 1)
    .map((l) => (l.startsWith('  ') ? l.slice(2) : l))
    .join('\n')
}

/** 取嵌套子段（如 settings.mcp）：返回该子段的原始文本，缩进对齐到 4。 */
function subSlice(parent, child) {
  const { start, end } = section(parent)
  const startRe = new RegExp(`^    ${child}: \\{$`)
  let s = -1
  for (let i = start; i <= end; i++) {
    if (startRe.test(lines[i])) {
      s = i
      break
    }
  }
  if (s < 0) throw new Error(`subsection not found: ${parent}.${child}`)

  let depth = 0
  let e = -1
  for (let i = s; i <= end; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    if (depth === 0 && i > s) {
      e = i
      break
    }
  }
  if (e < 0) throw new Error(`subsection end not found: ${parent}.${child}`)

  // 去掉尾部逗号，把缩进从 4 减到 4（保持），作为 `mcp: { ... }` 的值
  return lines.slice(s, e + 1).join('\n')
}

const skills = slice('skills')
const connectorsPage = slice('connectorsPage')
const common = slice('common')
const mcp = subSlice('settings', 'mcp')
const plugins = subSlice('settings', 'plugins')
const pagination = subSlice('ui', 'pagination')
const uiSearch = subSlice('ui', 'search')

// catalog 在独立文件 zh_catalog.ts（导出的是裸对象字面量，不是 `catalog: {` 形式）
const catalogSrc = fs.readFileSync(SRC_CATALOG, 'utf8')
const catalogMatch = /export const zhCatalog = \{([\s\S]*?)\n\} satisfies/.exec(catalogSrc)
  ?? /export const zhCatalog = \{([\s\S]*)\n\}\s*$/.exec(catalogSrc)
if (!catalogMatch) throw new Error('zhCatalog object not found')
// 内层缩进保持（原本是 2，现在要嵌到 `catalog: {` 里 → 加 2）
const catalogBody = catalogMatch[1]
  .split('\n')
  .map((l) => (l.trim() ? `  ${l}` : l))
  .join('\n')
const catalog = `  catalog: {${catalogBody}\n  }`

const header = `/**
 * hermes 桌面端 capabilities 模块的中文文案 —— **从上游 zh.ts 逐字抽取**
 * （脚本：\`scripts/extract-capabilities-copy.mjs\`，不要手改本文件）。
 *
 * 抽取范围：\`skills\` / \`catalog\` / \`connectorsPage\` / \`common\` 四个整段，
 * 加 \`settings.mcp\` / \`settings.plugins\` / \`ui.pagination\` / \`ui.search\`
 * 四个子段。上游是 4764 行的多语言文件，这里只搬 capabilities 用到的部分。
 *
 * **改文案 = 改上游再重跑脚本**。手改会在下次同步时丢失，也会与上游漂移。
 */

const zh = {
`

const footer = `
} as const

export type CapabilitiesCopy = typeof zh

export { zh }
`

const body = [
  skills,
  catalog,
  connectorsPage,
  common,
  `  settings: {\n${mcp},\n${plugins}\n  },`,
  `  ui: {\n${pagination},\n${uiSearch}\n  },`,
].join(',\n\n')

fs.writeFileSync(OUT, header + body + footer, 'utf8')
const count = fs.readFileSync(OUT, 'utf8').split('\n').length
console.log(`wrote ${OUT} (${count} lines)`)
