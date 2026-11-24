/**
 * 品牌字标（上游 `components/chat/wordmark.tsx` 的宿主复制）。
 *
 * 上游空对话的巨型字标（"HERMES AGENT" / 机器人名字）都走这一个组件：
 * 可见文字的字号由容器宽度驱动（`.fit-text`），铺满整列——不是写死的
 * 32px。结构里的第二份 `aria-hidden` 文案是宽度参照，不能删。
 *
 * 宿主旧版把 `text` prop 吞掉、只渲染 "Mirach"，但 hermes-bots 的
 * BotChatEmpty 传机器人名，界面却恒显示 "Mirach"。现在完整保留上游签名；
 * `size` 只在旧调用点显式传时生效，默认走 fit-text。
 */
import type { CSSProperties, FC } from 'react'

import { cn } from '@/lib/utils'

export interface WordmarkProps {
  className?: string
  /** 旧版宿主的固定字号档位；不传 = 上游 fit-text。 */
  size?: 'sm' | 'md' | 'lg'
  /** 显示文字（上游必需 prop——空对话字标/机器人名）。缺省 = 宿主品牌名。 */
  text?: string
  /** `.fit-text` 的字号下限，CSS length。 */
  fitMin?: string
  /** 字标铺满的横向宽度；上游默认列宽减 1rem。 */
  width?: string
}

const SIZE: Record<NonNullable<WordmarkProps['size']>, string> = {
  sm: 'text-[13px]',
  md: 'text-[15px]',
  lg: 'text-[18px]',
}

export const Wordmark: FC<WordmarkProps> = ({
  className,
  size,
  text = 'Mirach',
  fitMin = '2.75rem',
  width = 'calc(100% - 1rem)',
}) => {
  if (size) {
    return (
      <p
        aria-label={text}
        className={cn(
          'select-none text-center font-semibold tracking-tight text-[var(--text)] mx-auto',
          SIZE[size],
          className,
        )}
        data-slot="wordmark"
      >
        {text}
      </p>
    )
  }

  return (
    <p
      aria-label={text}
      className={cn('mirach-wordmark fit-text mx-auto', className)}
      data-slot="wordmark"
      style={{ '--fit-min': fitMin, width } as CSSProperties}
    >
      <span>
        <span>{text}</span>
      </span>
      <span aria-hidden="true">{text}</span>
    </p>
  )
}
