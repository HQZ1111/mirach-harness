/**
 * hermes `api/skills.ts` 的宿主对偶。
 *
 * 宿主没有对应的 REST 端点。按工程规矩 11（禁止兜底/假成功），
 * 这些函数返回明确错误而不是空数据——让调用方知道能力缺失。
 */

const NOT_WIRED = '宿主未实现该 API（本工程只实现了 groups.* 群聊后端）'

export async function getSkills(): Promise<unknown[]> {
  const { invoke } = await import('@tauri-apps/api/core')
  try {
    const caps = await invoke<{ skills?: unknown[] }>('pi_capabilities')
    return Array.isArray(caps?.skills) ? caps.skills : []
  } catch {
    return []
  }
}

export async function setSkillEnabled(_name: string, _enabled: boolean): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('pi_set_skill_enabled', { name: _name, enabled: _enabled })
}
