/**
 * hermes 同款 codicon 图标（@vscode/codicons 的 SVG path 内联——harness 没有
 * codicon 字体）。折叠/还原切换用：chevron-down = 最小化（图标指向 zone 要去
 * 的方向，向下折进轨道）、chevron-up = 还原（向上开回网格）——hermes
 * tree-group.tsx 的语义逐字。
 */

export function ChevronDownIcon({ size = 12 }: { size?: number }) {
  return (
    <svg aria-hidden fill="currentColor" height={size} viewBox="0 0 16 16" width={size}>
      <path d="M3.14598 5.85423L7.64598 10.3542C7.84098 10.5492 8.15798 10.5492 8.35298 10.3542L12.853 5.85423C13.048 5.65923 13.048 5.34223 12.853 5.14723C12.658 4.95223 12.341 4.95223 12.146 5.14723L7.99998 9.29323L3.85398 5.14723C3.65898 4.95223 3.34198 4.95223 3.14698 5.14723C2.95198 5.34223 2.95098 5.65923 3.14598 5.85423Z" />
    </svg>
  )
}

export function ChevronUpIcon({ size = 12 }: { size?: number }) {
  return (
    <svg aria-hidden fill="currentColor" height={size} viewBox="0 0 16 16" width={size}>
      <path d="M3.14603 9.85423C3.34103 10.0492 3.65803 10.0492 3.85303 9.85423L7.99903 5.70823L12.145 9.85423C12.34 10.0492 12.657 10.0492 12.852 9.85423C13.047 9.65923 13.047 9.34223 12.852 9.14723L8.35203 4.64723C8.15703 4.45223 7.84003 4.45223 7.64503 4.64723L3.14503 9.14723C2.95003 9.34223 2.95103 9.65923 3.14603 9.85423Z" />
    </svg>
  )
}
