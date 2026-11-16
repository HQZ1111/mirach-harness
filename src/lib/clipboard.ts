/**
 * 剪贴板（hermes `lib/clipboard.ts` 的宿主对偶）。
 *
 * 上游包一层 Electron clipboard。宿主浏览器环境直接用 `navigator.clipboard`，
 * 失败时回退到 `document.execCommand`（老 WebView2 兼容）。
 */

export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 权限被拒 → 回退
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.append(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

export async function readText(): Promise<string | null> {
  try {
    return (await navigator.clipboard?.readText?.()) ?? null
  } catch {
    return null
  }
}

/** 上游 `writeClipboardText`：copyText 的别名（上游用这个名字）。 */
export const writeClipboardText = copyText
