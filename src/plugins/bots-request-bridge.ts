/**
 * 配置档案栏 → 机器人页对话框的桥（2026-11-26，hermes ProfileRail 的
 * 右键/「+」入口对偶）。
 *
 * 宿主唯一的机器人 UI 是 hermes-bots 插件（BotsPane）；档案栏在宿主
 * 组件树里（插件外）。档案栏只发**动作请求**，由插件消费后打开自己的
 * 新建/编辑/删除对话框——不复制一套机器人表单，也不在插件关闭时放假
 * 入口（调用方先过 `useBotsFeatureDesired`）。
 *
 * 时序：请求先入模块级 pending，再派发事件。BotsPane 可能尚未挂载
 * （机器人栏没开）——调用方先 `openBotsPanel()`，面板挂载时
 * `consumeBotsRequest()` 取走 pending；已挂载则事件即时消费。
 */
export type BotsActionRequest =
  | { kind: 'create' }
  | { kind: 'delete'; name: string }
  | { kind: 'edit'; name: string }

const BOTS_REQUEST_EVENT = 'mirach:bots:request'

let pending: BotsActionRequest | null = null

export function requestBotsAction(request: BotsActionRequest): void {
  pending = request
  window.dispatchEvent(new CustomEvent<BotsActionRequest>(BOTS_REQUEST_EVENT, { detail: request }))
}

/** 面板挂载时取走最后一个请求（没有 = null）。 */
export function consumeBotsRequest(): BotsActionRequest | null {
  const request = pending
  pending = null
  return request
}

/** 面板在屏时订阅后续请求；返回退订。 */
export function subscribeBotsRequests(listener: (request: BotsActionRequest) => void): () => void {
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<BotsActionRequest>).detail
    if (!detail || typeof detail !== 'object') return
    listener(detail)
  }
  window.addEventListener(BOTS_REQUEST_EVENT, handler)
  return () => window.removeEventListener(BOTS_REQUEST_EVENT, handler)
}
