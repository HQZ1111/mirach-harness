/**
 * hermes `api/profiles.ts` 的宿主对偶。
 *
 * 宿主没有对应的 REST 端点。按工程规矩 11（禁止兜底/假成功），
 * 这些函数返回明确错误而不是空数据——让调用方知道能力缺失。
 */

const NOT_WIRED = '宿主未实现该 API（本工程只实现了 groups.* 群聊后端）'

export async function getProfiles(): Promise<unknown[]> {
  // 宿主单 profile：返回真实的本地身份（不是假数据）
  return [{ id: 'local', name: 'Local', isDefault: true }]
}
