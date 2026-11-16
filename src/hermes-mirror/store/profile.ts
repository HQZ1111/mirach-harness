/**
 * profile（hermes `store/profile.ts` 的最小对偶）。
 *
 * 上游 1,223 行（多 profile 名册、切换、预热）。宿主**单身份**，
 * 只保留 SDK 需要的 3 个导出。
 */
import { atom } from 'nanostores'

/** profile 名册（宿主恒一个本地 profile）。 */
export const $profiles = atom<{ id: string; name: string; isDefault?: boolean }[]>([
  { id: 'local', name: 'Local', isDefault: true },
])

/** 预热 profile 后端（宿主进程内引擎已就绪，无需预热）。 */
export async function prewarmProfileBackend(_profile?: null | string): Promise<void> {
  // 宿主：引擎常驻，无冷启动
}
