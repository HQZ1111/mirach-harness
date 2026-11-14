import { readFileSync, writeFileSync } from 'node:fs'

const p = 'src/hermes-shim/hermes.ts'
let t = readFileSync(p, 'utf8')
// ActionResponse = {name, ok, pid, ...} — no message field. Functions that
// cannot act must throw (rule 12) rather than return a shaped-but-false value.
t = t.replace("return { key, message: '本宿主没有 post-setup 步骤', ok: false }", "throw new Error('本宿主没有 post-setup 步骤')")
t = t.replace("return { message: '本宿主没有可授予的 OS 权限', ok: false }", "throw new Error('本宿主没有可授予的 OS 权限')")
// ConfigSchemaResponse.fields is Record<string, ConfigFieldSchema>.
t = t.replace('return { fields: [] }', 'return { fields: {} }')
writeFileSync(p, t, 'utf8')
console.log(
  'post-setup throws =',
  t.includes("throw new Error('本宿主没有 post-setup 步骤')"),
  '| fields {} =',
  t.includes('fields: {}')
)
