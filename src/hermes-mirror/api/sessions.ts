/**
 * hermes `api/sessions.ts` 的宿主对偶。
 *
 * 宿主没有对应的 REST 端点。按工程规矩 11（禁止兜底/假成功），
 * 这些函数返回明确错误而不是空数据——让调用方知道能力缺失。
 */

const NOT_WIRED = '宿主未实现该 API（本工程只实现了 groups.* 群聊后端）'

/** 会话变更（fenced）。宿主走 pi 的会话命令。 */
export async function mutateSessionFenced<T>(fn: () => Promise<T>): Promise<T> {
  return fn()
}
