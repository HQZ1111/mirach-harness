/** 预览页签开启器：flex-layout 注册实现，文件树调用（解耦不引环）。 */
let opener: ((filePath: string, fileName: string) => void) | null = null

export function setPreviewOpener(fn: (filePath: string, fileName: string) => void) {
  opener = fn
}

export function openFilePreview(filePath: string, fileName: string) {
  opener?.(filePath, fileName)
}
