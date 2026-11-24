/**
 * composer 贡献面的宿主消费原语（hermes `app/chat/composer/contrib.ts` 的对偶）。
 *
 * 上游 composer 有三类数据/渲染贡献（`ctx.register` 到 `COMPOSER_AREAS.*`）：
 * - `composer.atCompletions`：`{provide(query) => MentionCompletionItem[]}`
 *   —— @ 补全的额外行（hermes-bots 用它给出机器人 handle）；
 * - `composer.middleware`：`{handler(draft) => draft | null}` —— 提交前逐段
 *   改写（hermes-bots 的 /new→/compact 守卫与 @身份注记）；
 * - `composer.top`：渲染型 banner 条（hermes-bots 的「等待队友」）。
 *
 * 宿主（mirach）没有 hermes 的完整 composer 贡献区系统，但这三个 area 的
 * **数据形状**照抄上游（`ctx.register({area:'composer.atCompletions', data})`
 * 原样进 registry），所以消费面只需要一个读注册表 + 跑管线的薄层：
 * - 补全行由 `ComposerWired` 在渲染时同步取（上游同款：逐键同步应答）；
 * - middleware 由 runtime `onNew` 在发送前跑（真正的提交门）；
 * - top 由 `ComposerTopSlot` 渲染（挂 ComposerBar 首行）。
 *
 * 语义要点（与上游 `runComposerMiddleware` 逐条对齐）：
 * - 按注册顺序执行；**首个返回 null 取消发送**；
 * - handler 抛错视为透传（console.error 可见，不吞）。
 */

import { registry } from './registry'

export const COMPOSER_AT_COMPLETIONS_AREA = 'composer.atCompletions'
export const COMPOSER_MIDDLEWARE_AREA = 'composer.middleware'
/** 上游 `COMPOSER_AREAS.top`：输入框上方的 banner 条（hermes-bots 的
 *  teammate-waits 挂这里）。宿主 composer 的对应槽位在 ComposerWired。 */
export const COMPOSER_TOP_AREA = 'composer.top'

/** 上游 `MentionCompletionItem`（hermes-bots plugin.tsx 的本地类型同形）。 */
export interface ComposerAtCompletionItem {
  insert: string
  display?: string
  meta?: string
  handles?: string[]
}

interface AtCompletionSource {
  provide?: (query: string) => ComposerAtCompletionItem[]
}

export interface ComposerDraft {
  text: string
  attachments?: readonly unknown[]
}

type MiddlewareHandler = (draft: ComposerDraft) => ComposerDraft | null | Promise<ComposerDraft | null>

/** 当前注册的 @ 补全源（enabled/when 过滤由 registry.getArea 负责）。 */
export function composerAtCompletionSources(): AtCompletionSource[] {
  return registry
    .getArea(COMPOSER_AT_COMPLETIONS_AREA)
    .map((c) => c.data as AtCompletionSource)
    .filter((d): d is AtCompletionSource => typeof d?.provide === 'function')
}

/**
 * 跑 composer.middleware 管线。返回 null = 取消发送；否则返回改写后的
 * draft。handler 抛错按透传处理（上游语义；错误 console 可见）。
 */
export async function runComposerMiddleware(draft: ComposerDraft): Promise<ComposerDraft | null> {
  let current = draft
  for (const contribution of registry.getArea(COMPOSER_MIDDLEWARE_AREA)) {
    const handler = (contribution.data as { handler?: unknown } | undefined)?.handler
    if (typeof handler !== 'function') continue
    try {
      const next = await (handler as MiddlewareHandler)(current)
      if (!next) return null
      current = next
    } catch (e) {
      console.error(`[composer] middleware ${contribution.id} 抛错——按透传处理`, e)
    }
  }
  return current
}
