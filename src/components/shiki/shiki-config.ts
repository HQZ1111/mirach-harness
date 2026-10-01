// ── 聊天代码块 shiki 常量（syntax-highlighter.tsx 与 lazy shiki-block.tsx 共用）
// ─────────────────────────────────────────────────────────────────────────────
// 本文件刻意零依赖（无 React、无 react-shiki）：lazy 块要引用这些常量，但
// 入口图（markdown-text → syntax-highlighter）绝不能被拖进 react-shiki 的
// 多 MB bundle——只有 shiki-block.tsx 一个文件允许静态 import react-shiki。

/**
 * 主题 = hermes 同款（chat/shiki-config.ts 逐值）：
 * - 亮色 github-light-default / 暗色 github-dark-dimmed（GitHub 低对比暗色，
 *   高饱和 token 在小字号下刺眼）；
 * - 输出走 defaultColor:'light-dark()'，配色跟随文档 color-scheme——
 *   本应用 :root 是 color-scheme: light，即亮色盘生效，未来翻暗色免改代码。
 */
export const SHIKI_THEMES = {
  light: 'github-light-default',
  dark: 'github-dark-dimmed',
} as const

/**
 * 亮色主题把注释染成 #6e7781（对代码卡底色 ~4.2:1），小字号 shell 片段里
 * 一个 # 就把整行拖成一条长注释——按 hermes 同款把亮色注释重映射到更深的
 * 灰（#57606a，~6.4:1）。暗色注释 #8b949e 已够读，不动。按主题名做键，
 * 替换只作用于亮色盘。
 */
export const SHIKI_COLOR_REPLACEMENTS: Record<string, Record<string, string>> = {
  'github-light-default': { '#6e7781': '#57606a' },
}

/**
 * 内容寻址高亮缓存的键前缀（scope）。主题/颜色替换变了必须 bump——
 * 缓存键不允许悄悄产出与计算时不同的 DOM。
 */
export const SHIKI_HIGHLIGHT_SCOPE = `mirach-shiki-v1:${JSON.stringify({
  themes: SHIKI_THEMES,
  colorReplacements: SHIKI_COLOR_REPLACEMENTS,
})}`

// 高亮预算（hermes 同款四件套之三）：超出即放弃 tokenize，按纯文本分块渲染。
export const MAX_HIGHLIGHT_CHARS = 150_000
export const MAX_HIGHLIGHT_LINES = 3_000

// 内容键缓存的总量上限，单位 = 源码字符（hermes 按 html 字符 6MB 计；本工程
// 缓存的是 React 元素树，按源码 600k 字符计，元素树约 5-10 倍 ≈ 同量级内存）。
export const HIGHLIGHT_CACHE_MAX_SOURCE_CHARS = 600_000
// 超预算块的分块行数；块间 content-visibility:auto 让视口外的块跳过渲染。
export const CHUNK_LINES = 200
// 纯文本块的估算行高（px），供 contain-intrinsic-size 占位，滚动条不跳。
export const EST_LINE_PX = 16

// 流式期间的 highlight 节流（hermes HIGHLIGHT_DELAY_MS 同款），交给
// react-shiki 的 delay 选项执行。
export const HIGHLIGHT_DELAY_MS = 120

// 复制按钮 copied 态的停留时长（任务定稿 1.5s）。
export const CODE_COPIED_DURATION_MS = 1_500
