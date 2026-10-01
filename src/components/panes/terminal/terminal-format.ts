/**
 * 终端纯逻辑小件（无 React/无 IPC——单测覆盖）：
 * 页签名归一（ZCode formatShellLabel 同源）+ PTY 输出载荷解码。
 */

/** base64 → 字节（Tauri Event 载荷是 PTY 原始字节的 base64） */
export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** 页签名：路径取末段、去 .exe、小写归一（ZCode formatShellLabel 逐字同源） */
export function formatShellLabel(shell: string | null): string | null {
  if (!shell) {
    return null
  }

  const shellParts = shell.split(/[\\/]/)
  const lastPart = shellParts[shellParts.length - 1]
  const name = lastPart?.replace(/\.exe$/i, '').toLowerCase()
  if (!name) {
    return shell
  }
  if (name === 'powershell' || name === 'pwsh') {
    return 'PowerShell'
  }
  return name
}
