/**
 * 会话导出（hermes lib/session-export.ts 的 pi 实现版）：hermes 把消息打包
 * 成 JSON Blob 下载；pi 有原生 HTML 渲染面（Session::to_html /
 * export_snapshot——见 pi_session.rs pi_export_session_html），导出物 =
 * 独立 HTML 文档。落盘走 save 对话框（tauri-plugin-dialog）+ 宿主写文件
 * （fs_write_text_file——Tauri 无 Electron 的 Blob 下载通道）。
 *
 * 文件名 = hermes sessionExportFilename 同款 sanitize（标题净化 + id 前
 * 8 位），扩展名 .html。
 */
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'

function sanitizeFilenamePart(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
}

export function sessionExportFilename(sessionId: string, title?: string | null) {
  const titlePart = title ? sanitizeFilenamePart(title) : ''
  const idPart = sanitizeFilenamePart(sessionId).slice(0, 8) || 'session'

  return `${titlePart || 'session'}-${idPart}.html`
}

/** 导出执行（失败 throw——调用方 console.error 可见；用户取消保存 = null
 *  路径，静默返回不算错误）。 */
export async function exportSessionHtml(params: {
  sessionId: string
  path: string
  title?: string | null
}): Promise<void> {
  const html = await invoke<string>('pi_export_session_html', { path: params.path })
  const target = await save({ defaultPath: sessionExportFilename(params.sessionId, params.title) })
  if (!target) return
  await invoke('fs_write_text_file', { path: target, contents: html })
}
