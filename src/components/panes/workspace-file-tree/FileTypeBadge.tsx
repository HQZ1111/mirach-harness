/* 文件类型徽章：从本工程 hermes-sidebar/hermes-file-tree-pane.tsx 的 FileGlyph
 * 原样迁入（ZCode 的 FileDisplayIcon 依赖按扩展名分发的 SVG 资产，工程没有）。
 * 无匹配扩展名 → lucide FileText 兜底字形（与旧窗格一致）。 */
import { FileText } from "lucide-react";

interface FileKind {
  label: string
  color: string
  bg: string
}
const FILE_KINDS: Array<{ exts: string[]; kind: FileKind }> = [
  { exts: ['ts', 'tsx'], kind: { label: 'TS', color: '#3178c6', bg: 'rgba(49,120,198,0.15)' } },
  { exts: ['js', 'jsx', 'mjs', 'cjs'], kind: { label: 'JS', color: '#b7791f', bg: 'rgba(183,121,31,0.15)' } },
  { exts: ['json'], kind: { label: '{}', color: '#8a8a00', bg: 'rgba(138,138,0,0.14)' } },
  { exts: ['css'], kind: { label: 'CSS', color: '#0ea5e9', bg: 'rgba(14,165,233,0.15)' } },
  { exts: ['html', 'htm'], kind: { label: '<>', color: '#e06c35', bg: 'rgba(224,108,53,0.15)' } },
  { exts: ['md'], kind: { label: 'MD', color: '#5b6bd6', bg: 'rgba(91,107,214,0.15)' } },
  { exts: ['rs'], kind: { label: 'RS', color: '#c2410c', bg: 'rgba(194,65,12,0.15)' } },
  { exts: ['toml', 'yaml', 'yml', 'ini', 'conf'], kind: { label: 'CFG', color: '#64748b', bg: 'rgba(100,116,139,0.15)' } },
  { exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'], kind: { label: 'IMG', color: '#9333ea', bg: 'rgba(147,51,234,0.15)' } },
  { exts: ['lock'], kind: { label: 'LCK', color: '#52525b', bg: 'rgba(82,82,91,0.15)' } },
]

export function FileTypeBadge({ name }: { name: string }) {
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
  const kind = ext ? FILE_KINDS.find((k) => k.exts.includes(ext))?.kind : undefined
  if (!kind) return <FileText className="size-4 shrink-0 text-(--text-3)" />
  return (
    <span
      className="grid h-4 w-5 shrink-0 place-items-center rounded-[3px] text-[0.5rem] font-bold leading-none"
      style={{ background: kind.bg, color: kind.color }}
    >
      {kind.label}
    </span>
  )
}
