/**
 * 上游 `app/chat/composer/scope.tsx:66-81` 的 ComposerSession 段逐字宿主对偶。
 *
 * 上游同文件还带 `ComposerScope`（每 tile 一套附件/transcript/focus 总线），
 * 宿主只有单个 composer，没有那套作用域体系；`composer.top` 贡献只依赖
 * 「这段 composer 属于哪个会话」这一个契约，所以这里只保留它。
 *
 * 契约：`sessionId` = composer 挂载时的运行期会话 id（新草稿为 null）；
 * `storedSessionId` = 落盘 id（运行期 id 经 session store 映射，无映射即自身）。
 */
import { createContext, useContext } from 'react'

/** The session a composer belongs to, as its `composer.top` contributions see it. */
export interface ComposerSessionInfo {
  /** The session id the composer was mounted for (`null` on a fresh draft). */
  sessionId: null | string
  /** The durable id it is filed under — the runtime id mapped through the session store. */
  storedSessionId: null | string
}

const ComposerSessionContext = createContext<ComposerSessionInfo>({ sessionId: null, storedSessionId: null })

export const ComposerSessionProvider = ComposerSessionContext.Provider

/** Which session this composer is for, read from inside a `composer.top` contribution. A tile's
 *  composer and the main one answer for their OWN session, so a plugin banner never shows one
 *  chat's state above another chat's input. */
export const useComposerSession = (): ComposerSessionInfo => useContext(ComposerSessionContext)
