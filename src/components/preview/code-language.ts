/**
 * 代码预览纯函数：扩展名 → Shiki 语言映射 + 高亮预算判定。
 * 映射表与解析逻辑逐值照抄 hermes（apps/desktop/src/lib/markdown-code.ts 的
 * SHIKI_LANGUAGE_BY_EXTENSION / shikiLanguageForFilename）——未知扩展名返回
 * ''（调用方回退纯文本渲染，不猜语言）。
 */

/** 最后一个路径段的扩展名（或 Dockerfile 等裸文件名的小写形式）。
 *  hermes filenameExtToken 同构：反斜杠归一成斜杠 + trim + 小写。 */
function filenameExtToken(path: string | undefined): string {
  const base = (path || '').replace(/\\/g, '/').split('/').pop()!.trim().toLowerCase()
  const dot = base.lastIndexOf('.')

  return dot > 0 ? base.slice(dot + 1) : base
}

// 文件扩展名 → Shiki bundled language id（hermes 原表逐值照抄；
// 未知扩展名查不到 → ''，调用方走纯文本）。
const SHIKI_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  astro: 'astro',
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  clj: 'clojure',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  cxx: 'cpp',
  dart: 'dart',
  dockerfile: 'docker',
  ex: 'elixir',
  exs: 'elixir',
  fish: 'fish',
  go: 'go',
  gql: 'graphql',
  graphql: 'graphql',
  h: 'c',
  hpp: 'cpp',
  hs: 'haskell',
  htm: 'html',
  html: 'html',
  ini: 'ini',
  java: 'java',
  jl: 'julia',
  js: 'javascript',
  json: 'json',
  json5: 'json5',
  jsonc: 'jsonc',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'less',
  lua: 'lua',
  makefile: 'make',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'mdx',
  mjs: 'javascript',
  ml: 'ocaml',
  mts: 'typescript',
  nix: 'nix',
  php: 'php',
  pl: 'perl',
  proto: 'proto',
  ps1: 'powershell',
  py: 'python',
  pyi: 'python',
  r: 'r',
  rb: 'ruby',
  rs: 'rust',
  sass: 'sass',
  scala: 'scala',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  svelte: 'svelte',
  swift: 'swift',
  tf: 'terraform',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zig: 'zig',
  zsh: 'bash',
}

export function shikiLanguageForFilename(path: string | undefined): string {
  return SHIKI_LANGUAGE_BY_EXTENSION[filenameExtToken(path)] || ''
}

/** 该文件是否走代码渲染（扩展名在映射表内）。 */
export function isCodePreviewFile(path: string | undefined): boolean {
  return shikiLanguageForFilename(path) !== ''
}

// ── 高亮预算（hermes 同款诚实降级，非兜底：降级本身对用户可见）──
// 超过任一阈值不做语法高亮（全量 tokenize 大文件会卡），回退纯文本分块。
// 字节阈值对应 hermes preview 的 TEXT_PREVIEW_MAX_BYTES（512KB），
// 行数阈值对应 hermes 聊天代码块的 MAX_HIGHLIGHT_LINES（3k 行）。
export const CODE_BUDGET_MAX_BYTES = 512 * 1024
export const CODE_BUDGET_MAX_LINES = 3_000

/** 文本超出高亮预算：UTF-8 字节 > 512KB 或行数 > 3000。 */
export function exceedsHighlightBudget(text: string): boolean {
  if (new TextEncoder().encode(text).byteLength > CODE_BUDGET_MAX_BYTES) {
    return true
  }

  let lines = 1
  let idx = text.indexOf('\n')

  while (idx !== -1) {
    if ((lines += 1) > CODE_BUDGET_MAX_LINES) {
      return true
    }

    idx = text.indexOf('\n', idx + 1)
  }

  return false
}
