/**
 * Markdown 代码块辅助（hermes `lib/markdown-code.ts` 的最小对偶）。
 *
 * 上游这个模块除了语言判定，还导出「文件/语言 → codicon 名」的映射
 * （`file-type-icon.tsx` 依赖它）。这里把两者合并，避免上游组件改 import。
 */
export {
  codiconForFilename,
  codiconForLanguage,
} from '@/lib/icons'

/** 从 `className` 取代码块语言。 */
export function codeBlockLanguage(className?: string): string {
  const match = /language-([\w-]+)/.exec(className ?? '')
  return match?.[1] ?? 'text'
}

/** 是否是代码块（带 language- 前缀）。 */
export function isCodeBlock(className?: string): boolean {
  return /language-/.test(className ?? '')
}