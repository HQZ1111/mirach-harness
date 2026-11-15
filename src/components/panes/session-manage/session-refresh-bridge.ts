/**
 * 会话列表刷新 bridge —— 项目/归属变更的**跨会话面刷新**通道。
 *
 * 为什么需要：`refreshThreads` 住在 runtime（唯一知道 pi_list_sessions +
 * pi_sessions_index 合并链的地方）。侧栏行菜单（「移到项目」）与设置页
 * （项目增删改、归档恢复/批量删除）只改 Rust 的 session-meta，不重拉索引
 * 就会一直显示旧的 projectId（Rust 侧的 cwd 推断只有重扫才知道）。
 *
 * 形态照抄 session-tab-bridge：runtime 注册实现、其余模块调 request；
 * 未注册时调用 = console.error 可见（规矩 12：不静默装成功）。
 */

type SessionListRefresher = () => void

let refresher: SessionListRefresher | null = null

export function setSessionListRefresher(fn: SessionListRefresher | null): void {
  refresher = fn
}

/** 请求重拉会话列表/索引。未注册时只报错——调用方已经完成自己的写，
 *  不做回滚（写本身成功了；刷新只是投影面）。 */
export function requestSessionListRefresh(): void {
  if (refresher === null) {
    console.error('[session-refresh-bridge] refreshThreads 未注册（runtime 未挂载）')
    return
  }
  refresher()
}
