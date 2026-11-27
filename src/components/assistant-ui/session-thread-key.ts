/**
 * 会话 ↔ 事件线程键（多会话并存 2026-11-28 的单一来源）。
 *
 * 引擎（agui.rs POST）把每个 run 的事件路由到 `main:<piSessionId>` 专属
 * 缓冲；前端 actor 注册表 / SSE 订阅 / 排队消息 / composer 草稿全部用同一
 * 个键。New Chat（尚未有会话）用 `main:__new__` 哨兵——不会有任何引擎事件
 * 落在这个键上（首条消息发送前 runtime 先 pi_ensure_main_session 拿到真
 * id，切到真键），只是草稿/队列的宿主。
 *
 * 改键名 = 三端（Rust 路由 / 前端订阅 / 持久化）一起改，先看本文件注释。
 */
export const NEW_CHAT_THREAD_KEY = 'main:__new__'

export function sessionThreadKey(id: string | null): string {
  return id ? `main:${id}` : NEW_CHAT_THREAD_KEY
}
