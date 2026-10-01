import { type ComponentProps, type ReactNode } from 'react'
import { CheckIcon, CopyIcon } from 'lucide-react'

import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard'
import { cn } from '@/lib/utils'

import { CODE_COPIED_DURATION_MS } from './shiki-config'

/**
 * 围栏代码（及等价物：原始载荷等）的圆角底色板，为会话栏宽度而设。
 * 只有底色——无边框、无头栏、无语言标签（hermes code-card 同款）——代码块
 * 读作回复里的一块着色板面，而非附件卡片。复制钮悬停显形，钉在右上角。
 */
export function CodeCard({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        // text-(length:--x)：tailwind v4 裸 text-(--var) 会解析成 color（实测
        // 4.3.3），字号必须带 length: 类型提示。底色/圆角/字号复用
        // tokens.css 代码预览段令牌（--code-bg/--code-radius/--code-font-size）
        // ——全应用同一「代码板面」观感。
        'group/code relative min-w-0 max-w-full overflow-hidden rounded-(--code-radius) bg-(--code-bg) text-(length:--code-font-size) text-foreground',
        className,
      )}
      data-slot="code-card"
      {...props}
    />
  )
}

export function CodeCardBody({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        // shiki 输出的 pre 自带主题内联底色（light-dark()）——压透明让卡片
        // 底色令牌透出来（hermes CodeCardBody 的 [&_pre]:bg-transparent! 同款）。
        '[&_pre]:m-0 [&_pre]:bg-transparent! [&_pre]:px-3 [&_pre]:py-2.5 font-mono leading-relaxed',
        className,
      )}
      data-slot="code-card-body"
      {...props}
    />
  )
}

/**
 * 卡片角上的复制控制：常态隐形（opacity-0），卡片悬停/键盘聚焦显形；
 * copied 态 1.5s（CODE_COPIED_DURATION_MS）后弹回。文本走 navigator.clipboard，
 * 失败静默留在 Copy 态之外（useCopyToClipboard 语义）。
 */
export function CodeCopyButton({
  code,
  label,
  className,
}: {
  code: string
  label: string
  className?: string
}): ReactNode {
  const { isCopied, copyToClipboard } = useCopyToClipboard({
    copiedDuration: CODE_COPIED_DURATION_MS,
  })

  return (
    <button
      aria-label={label}
      className={cn(
        'absolute right-2 top-1.5 z-10 flex h-5 w-5 items-center justify-center rounded-md text-(--text-3) opacity-0 transition-opacity duration-150 group-hover/code:opacity-100 hover:text-(--text-2) focus-visible:opacity-100 focus-visible:outline-(--fl-accent)',
        className,
      )}
      onClick={() => {
        if (code && !isCopied) copyToClipboard(code)
      }}
      title={label}
      type="button"
    >
      {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </button>
  )
}
