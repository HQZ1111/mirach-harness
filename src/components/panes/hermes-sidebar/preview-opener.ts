/** 预览页签开启器：布局壳注册实现（v8.0=dockview-shell），文件树调用
 *  （解耦不引环）。 */
let opener: ((filePath: string, fileName: string) => void) | null = null

export function setPreviewOpener(fn: ((filePath: string, fileName: string) => void) | null) {
  opener = fn
}

export function openFilePreview(filePath: string, fileName: string) {
  if (!opener) {
    console.error('[preview-opener] 预览通道未注册（布局壳未挂载）')
    return
  }
  opener(filePath, fileName)
}
