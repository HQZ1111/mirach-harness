/**
 * 头像图判定（宿主侧纯函数）——与插件 `hermes-bots/avatar-image.ts` 的
 * `isBackfilledFacePng` **同一判据**，复制到宿主 lib 是为了让不依赖插件
 * 运行时的宿主面（左栏底栏、消息头像）也能用：
 *
 * 插件把人脸 SVG 栅格化到 160×160 后经 `profiles.set_asset` 推成
 * server 侧头像（跨机名册/互认通知用）。这种「人脸回填」不是用户自定义
 * ——用户上传是 256、宠物是 96×104、生成的图片尺寸任意。宿主面据此决定
 * 显示**实时人脸**（随主题色/形状变化）还是静态图片。
 */

/** PNG data URL 的头 48 字节里读 IHDR 的宽高是否为 160×160。 */
export function isBackfilledFacePng(dataUrl: null | string | undefined): boolean {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    return false
  }
  try {
    const bin = atob(dataUrl.slice('data:image/png;base64,'.length).slice(0, 48))
    if (bin.length < 24) return false
    const w =
      (bin.charCodeAt(16) << 24) | (bin.charCodeAt(17) << 16) | (bin.charCodeAt(18) << 8) | bin.charCodeAt(19)
    const h =
      (bin.charCodeAt(20) << 24) | (bin.charCodeAt(21) << 16) | (bin.charCodeAt(22) << 8) | bin.charCodeAt(23)
    return w === 160 && h === 160
  } catch {
    return false
  }
}
