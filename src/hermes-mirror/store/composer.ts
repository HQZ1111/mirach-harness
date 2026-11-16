/**
 * composer 草稿（hermes `store/composer.ts` 的最小对偶）。
 *
 * 上游 980 行（草稿作用域、附件、IME、弹出窗）。SDK 只取 2 个：
 * `freshDraftScope` / `takeSessionDraft`。
 */
import { atom } from 'nanostores'

/** 草稿作用域（`'draft'` = 新会话，或存储会话 id）。 */
export type DraftScope = string

const drafts = atom<Record<DraftScope, string>>({})

/** 生成一个全新的草稿作用域。 */
export function freshDraftScope(): DraftScope {
  return `draft:${Date.now().toString(36)}`
}

/** 取走某作用域的草稿（取后清空，上游同语义）。 */
export function takeSessionDraft(scope: DraftScope): string {
  const all = drafts.get()
  const text = all[scope] ?? ''
  if (text) {
    const next = { ...all }
    delete next[scope]
    drafts.set(next)
  }
  return text
}

/** 写入草稿（宿主 composer 用）。 */
export function setSessionDraft(scope: DraftScope, text: string): void {
  drafts.set({ ...drafts.get(), [scope]: text })
}
