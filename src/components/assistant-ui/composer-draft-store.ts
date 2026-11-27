/**
 * Composer 草稿：**按会话分桶 + localStorage 持久化**
 * （2026-11-28 用户："输入框里的消息，切换会话后都没了，关闭重启应用也没了"）。
 *
 * 形态照抄 hermes `store/composer.ts` + `composer-draft-stash.ts`：
 * - 键 = `sessionThreadKey(id)`（New Chat 用 `main:__new__` 哨兵——宿主单
 *   New Chat 草稿，两个"未发送的新会话"不共存，比 hermes 的轮换键简单）；
 * - localStorage `mirach:composer-drafts.v1`，上限 50 条，超过按 updatedAt
 *   淘汰最旧（hermes MAX_PERSISTED_DRAFTS=50 同语义）；
 * - 只持久化**非空**文本（空 = 删除条目，hermes composer.ts:389 同款）；
 * - 附件不持久化（内存态；hermes/ZCode 同款——附件引用本地路径，重启后
 *   恢复反而容易指向已不存在的文件）。
 *
 * 读写时序纪律（composer-wired 接线用）：
 * - 焦点切换 → 先 `takeDraft(newKey)` 恢复文本，**同一轮渲染**内不得把旧
 *   会话的文本 stash 进新键（composer 侧用 prevKeyRef 跳过切键首帧）；
 * - 发送成功 → composer 清空 → value 变 '' → `setDraft(key, '')` = 删除。
 */
import { sessionThreadKey } from './session-thread-key'

const STORAGE_KEY = 'mirach:composer-drafts.v1'
const MAX_DRAFTS = 50

interface PersistedDraft {
  text: string
  updatedAt: number
}

interface PersistedDrafts {
  drafts: Record<string, PersistedDraft>
}

function loadAll(): Record<string, PersistedDraft> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as PersistedDrafts
    if (!parsed || typeof parsed.drafts !== 'object' || parsed.drafts === null) {
      console.error('[composer-draft] 草稿持久化形状非法——按空处理', STORAGE_KEY)
      return {}
    }
    const drafts: Record<string, PersistedDraft> = {}
    for (const [key, draft] of Object.entries(parsed.drafts)) {
      if (
        draft &&
        typeof draft === 'object' &&
        typeof draft.text === 'string' &&
        typeof draft.updatedAt === 'number'
      ) {
        drafts[key] = draft
      }
    }
    return drafts
  } catch (e) {
    console.error('[composer-draft] 草稿持久化读取失败——按空处理', e)
    return {}
  }
}

function persistAll(drafts: Record<string, PersistedDraft>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ drafts } satisfies PersistedDrafts))
  } catch (e) {
    console.error('[composer-draft] 草稿持久化写入失败（内存态不受影响）', e)
  }
}

/** 读一个会话的草稿文本（无 = ''）。 */
export function getComposerDraft(sessionId: string | null): string {
  const drafts = loadAll()
  return drafts[sessionThreadKey(sessionId)]?.text ?? ''
}

/**
 * 写一个会话的草稿（空文本 = 删除条目）。
 *
 * **跨窗口去抖合并（hermes draft-stash 的简化版）**：读-改-写之间另一窗口
 * 可能写过——先 loadAll 再覆盖本键，不整体替换。
 */
export function setComposerDraft(sessionId: string | null, text: string): void {
  const drafts = loadAll()
  const key = sessionThreadKey(sessionId)
  const trimmed = text.trim()
  if (!trimmed) {
    if (key in drafts) {
      delete drafts[key]
      persistAll(drafts)
    }
    return
  }
  // 超限淘汰最旧（updatedAt 升序队首）
  const keys = Object.keys(drafts)
  while (keys.length >= MAX_DRAFTS) {
    let oldest = keys[0] ?? null
    for (const k of keys) {
      if (!oldest || (drafts[k]?.updatedAt ?? 0) < (drafts[oldest]?.updatedAt ?? 0)) oldest = k
    }
    if (!oldest) break
    delete drafts[oldest]
  }
  drafts[key] = { text, updatedAt: Date.now() }
  persistAll(drafts)
}

/** 清一个会话的草稿（会话删除时调用；切换会话**不清**——切换是恢复语义）。 */
export function clearComposerDraft(sessionId: string | null): void {
  setComposerDraft(sessionId, '')
}
