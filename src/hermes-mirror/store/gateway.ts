/**
 * 网关请求（hermes `store/gateway.ts` 的**最小对偶**）。
 *
 * ## 上游是什么（2,355 行）
 *
 * WebSocket 网关客户端：连接、重连、profile 路由、请求-响应关联、事件分发。
 *
 * ## 宿主怎么做
 *
 * Mirach 是**进程内单引擎**，没有 WebSocket 网关。上游 SDK 只从这里取 3 个东西：
 *
 * - `requestGatewayForProfile(profile, method, params)` —— 定向到某 profile 的 RPC
 * - `requestGatewayForAgent(...)` —— 同上但按 agent
 * - `SpawnPriority` 类型
 *
 * 三者都转发到宿主的 `groups_dispatch` IPC（本工程实现的部分）。
 * 非 `groups.*` 方法明确报错而不是假成功。
 */

/** 请求优先级（上游类型）。 */
export type SpawnPriority = 'background' | 'foreground' | 'interactive'

async function dispatch<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  if (method.startsWith('groups.')) {
    return invoke<T>('groups_dispatch', { method, params })
  }
  throw new Error(
    `gateway: method '${method}' 在宿主未接线（本工程只实现了 groups.*；` +
      `session.*/profiles.*/skills.* 需另行对偶）`,
  )
}

/** 定向到某 profile 的请求（宿主单身份，profile 参数仅用于形状对齐）。 */
export function requestGatewayForProfile<T>(
  _profile: null | string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return dispatch<T>(method, params)
}

/** 按 agent 的请求。 */
export function requestGatewayForAgent<T>(
  _agent: unknown,
  method: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  return dispatch<T>(method, params)
}

/** 重启网关（宿主无网关，明确报错）。 */
export async function runGatewayRestart(): Promise<void> {
  throw new Error('gateway: 宿主没有 gateway 进程可重启')
}

/** 上游 `$gateway` 的宿主对偶（无对应能力时为空）。 */
export const $gateway = atom<unknown>(null)

/** 上游 `$gatewayState` 的宿主对偶（无对应能力时为空）。 */
export const $gatewayState = atom<unknown>(null)

/** 上游 `$gatewaySwapTarget` 的宿主对偶（无对应能力时为空）。 */
export const $gatewaySwapTarget = atom<unknown>(null)

/** 上游 `$connection` 的宿主对偶（无对应能力时为空）。 */
export const $connection = atom<unknown>(null)

/** 上游 `$activeGatewayProfile` 的宿主对偶（无对应能力时为空）。 */
export const $activeGatewayProfile = atom<unknown>(null)

/** 上游 `$hydrationSyncProfile` 的宿主对偶（无对应能力时为空）。 */
export const $hydrationSyncProfile = atom<unknown>(null)

/** 上游 `activeGatewayConnectionId` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const activeGatewayConnectionId = (): null | string => null

/** 上游 `gatewayActivationEpoch` 的宿主对偶（函数形态，见 `store/gateway.ts:434`）。 */
export const gatewayActivationEpoch = (): number => 0

/** 上游 `useGatewayActivationEpoch` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const useGatewayActivationEpoch = (): number => 0

/** 上游 `openGatewayForProfile` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const openGatewayForProfile = (..._args: unknown[]): Promise<void> => Promise.resolve()

/** 上游 `openGatewayForAgent` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const openGatewayForAgent = (..._args: unknown[]): Promise<void> => Promise.resolve()

/** 上游 `ensureGatewayProfile` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const ensureGatewayProfile = (..._args: unknown[]): Promise<void> => Promise.resolve()

/** 上游 `ensureGatewayAgent` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const ensureGatewayAgent = (..._args: unknown[]): Promise<void> => Promise.resolve()

/** 上游 `retainGatewayForRelay` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const retainGatewayForRelay = (..._args: unknown[]): void => {}

/** 上游 `retireLocalProfileGateways` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const retireLocalProfileGateways = (..._args: unknown[]): void => {}

/** 上游 `newSessionInAgent` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const newSessionInAgent = (..._args: unknown[]): void => {}

/** 上游 `newSessionInProfile` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const newSessionInProfile = (..._args: unknown[]): void => {}

/** 上游 `requestSessionResume` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const requestSessionResume = (..._args: unknown[]): void => {}

/** 上游 `rememberedSessionProfile` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const rememberedSessionProfile = (_id: null | string): null | string => null

/** 上游 `refreshProfiles` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const refreshProfiles = (): Promise<void> => Promise.resolve()

/** 上游 `selectProfile` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const selectProfile = (_p: null | string): void => {}

/** 上游 `setActiveProfile` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const setActiveProfile = (_p: null | string): void => {}

/** 上游 `setSessionOwnerHint` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const setSessionOwnerHint = (..._args: unknown[]): void => {}

/** 上游 `getSessionOwnerHints` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const getSessionOwnerHints = (): Record<string, string> => ({})

/** 上游 `dropTilesForProfile` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const dropTilesForProfile = (..._args: unknown[]): void => {}

/** 上游 `focusWorkspaceOwnerSessionTile` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const focusWorkspaceOwnerSessionTile = (..._args: unknown[]): void => {}

/** 上游 `sessionTileDelegate` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const sessionTileDelegate = (..._args: unknown[]): null => null

/** 上游 `ackStoredSessionId` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const ackStoredSessionId = (_id: string): void => {}

/** 上游 `markSessionUnreadFinished` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const markSessionUnreadFinished = (_id: string): void => {}

/** 上游 `randomUuid` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const randomUuid = (): string => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()))

/** 上游 `ProfileScope` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const ProfileScope: string = "local"

/** 上游 `LOCAL_CONNECTION_ID` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const LOCAL_CONNECTION_ID: string = "local"

/** 上游 `normalizeProfileKey` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const normalizeProfileKey = (_p: null | string): string => "local"

/** 上游 `retireLocalProfileGateways` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const retireLocalProfileGateways = (..._args: unknown[]): void => {}

/** 上游 `$messages` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const $messages: unknown = null

/** 上游 `$currentCwd` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const $currentCwd: unknown = null

/** 上游 `$currentModel` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const $currentModel: unknown = null

/** 上游 `$focusedRuntimeId` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const $focusedRuntimeId: unknown = null

/** 上游 `GatewayEvent` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const GatewayEvent: unknown = null

/** 上游 `DisplayLease` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const DisplayLease: unknown = null

/** 上游 `DisplayObserveResult` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const DisplayObserveResult: unknown = null

/** 上游 `DisplayStatus` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const DisplayStatus: unknown = null

/** 上游 `DisplayThumbnailResult` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const DisplayThumbnailResult: unknown = null

/** 上游 `ProfileSessionPreview` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const ProfileSessionPreview: unknown = null

/** 上游 `ProfilesCreateResult` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const ProfilesCreateResult: unknown = null

/** 上游 `SessionListRow` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const SessionListRow: unknown = null

/** 上游 `APPROVAL_RESPOND_TIMEOUT_MS` 的宿主对偶（未接线时为空实现，见文件头注释）。 */
export const APPROVAL_RESPOND_TIMEOUT_MS: number = 30000
