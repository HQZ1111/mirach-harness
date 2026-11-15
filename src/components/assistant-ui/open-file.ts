/**
 * 工具行文件 chip / 折叠 change 摘要 → 代码查看器面板（2026-11-15）。
 *
 * 入口复用现有文件预览链：`preview-opener`（布局壳注册）→ 单实例
 * `preview` 面板 + `HermesPreviewPane`（Shiki 高亮/行号/图片/HTML 分流）。
 * 不新造面板、不复制 fs 读取逻辑。
 *
 * 路径口径：
 * - 工具参数里的路径通常是**相对会话 cwd** 的（pi 工具在会话工作区里
 *   解析）；也可能是绝对路径。相对路径用 `activeSessionCwd()` 拼成绝对，
 *   与文件树/审阅面板同一工作区来源。
 * - 解析不出绝对路径（无 cwd / 空路径）→ `console.error` 可见，不静默
 *   打开错误文件（兜底禁令）。
 */
import { activeSessionCwd } from '@/components/panes/review-store'
import { openFilePreview } from '@/components/panes/hermes-sidebar/preview-opener'

/** 绝对路径判定（Windows 盘符 / UNC / POSIX 根）。 */
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/

/** 工具参数路径 → 绝对路径；无法解析返回 null。纯函数，可单测。 */
export function resolveWorkspaceFilePath(
  path: string | undefined,
  cwd: string | null = activeSessionCwd(),
): string | null {
  const trimmed = path?.trim()
  if (!trimmed) return null
  if (ABSOLUTE_PATH.test(trimmed)) return trimmed
  if (!cwd) return null
  const relative = trimmed
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/')
  if (!relative) return null
  return `${cwd.replace(/[\\/]+$/, '')}/${relative}`
}

/** 打开代码查看器面板；失败路径全部 `console.error` 可见。 */
export function openFileFromToolPath(
  path: string | undefined,
  cwd: string | null = activeSessionCwd(),
): void {
  const resolved = resolveWorkspaceFilePath(path, cwd)
  if (!resolved) {
    console.error('[open-file] 无法解析文件路径（空路径或缺少会话 cwd）', path, { cwd })
    return
  }
  const name = resolved.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || resolved
  openFilePreview(resolved, name)
}
