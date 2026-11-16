/** `@/lib/icons` 的宿主对偶：转发 `hermes-shim/lib/icons`（同一份上游实现）。 */
export * from '@/hermes-shim/lib/icons'

/** 文件名 → codicon 名（上游 codiconForFilename）。 */
export function codiconForFilename(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'symbol-method', tsx: 'symbol-method', js: 'symbol-method', jsx: 'symbol-method',
    json: 'json', md: 'markdown', css: 'symbol-color', html: 'code',
    png: 'file-media', jpg: 'file-media', svg: 'file-media', pdf: 'file-pdf',
    zip: 'file-zip', toml: 'settings-gear', yaml: 'settings-gear', yml: 'settings-gear',
  }
  return map[ext] ?? 'file'
}

/** 语言 → codicon 名（上游 codiconForLanguage）。 */
export function codiconForLanguage(language: string): string {
  const map: Record<string, string> = {
    typescript: 'symbol-method', javascript: 'symbol-method', json: 'json',
    markdown: 'markdown', css: 'symbol-color', html: 'code', python: 'symbol-method',
    rust: 'symbol-method', shell: 'terminal', sql: 'database',
  }
  return map[language.toLowerCase()] ?? 'code'
}
