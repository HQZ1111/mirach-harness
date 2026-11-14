/**
 * 每行的「数字雨」churn 条 —— hermes 桌面端
 * `app/right-sidebar/review/churn-bar.tsx`（59 行）的逐字移植。
 *
 * 右锚、被遮罩裁切的 Matrix 风格字形流，宽度 = 该文件变更量相对最大变更
 * 文件的比例。上游注释写明**当前未接线**（保留导出以备复活）；本工程同样
 * 保留并可选启用（审查行是 `relative isolate overflow-hidden` 时可用）。
 */

import { useMemo } from 'react'

import type { ReviewFile } from '@/components/panes/review-store'
import { useReview } from '@/components/panes/review-store'

const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾅﾆﾇﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾚﾜ0123456789:=*+<>¦'

const MASK = 'linear-gradient(to left, #000 45%, transparent)'

// Deterministic glyph run (FNV-1a seed → xorshift) so a file's rain is stable
// across renders instead of reshuffling every paint.
function rain(seed: string, len: number): string {
  let h = 2166136261

  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  }

  let out = ''

  for (let i = 0; i < len; i++) {
    h ^= h << 13
    h ^= h >>> 17
    h ^= h << 5
    out += GLYPHS[Math.abs(h) % GLYPHS.length]
  }

  return out
}

export function ChurnBar({ file }: { file: ReviewFile }) {
  // 上游 `$reviewMaxChurn` 是 computed atom；宿主按列表现算（同公式）。
  const max = useReview((s) => s.files.reduce((m, f) => Math.max(m, f.added + f.removed), 0))
  const fill = useMemo(() => rain(file.path, 200), [file.path])
  const width = max > 0 ? ((file.added + file.removed) / max) * 100 : 0

  if (width <= 0) {
    return null
  }

  return (
    <span
      aria-hidden
      className='pointer-events-none absolute inset-y-0 right-0 -z-10 block overflow-hidden text-right font-mono text-[0.7rem] leading-6 tracking-tight whitespace-nowrap opacity-30 dark:opacity-40'
      style={{
        WebkitMaskImage: MASK,
        color: `var(--ui-${file.added >= file.removed ? 'green' : 'red'})`,
        maskImage: MASK,
        width: `${width}%`,
      }}
    >
      {fill}
    </span>
  )
}
