/**
 * `@hermes/plugin-sdk` 的类型导出。
 *
 * ## 这些类型是什么
 *
 * 上游 SDK 导出的**纯类型**（编译期擦除）。bots 的 20+ 个文件用它们标注
 * 参数/返回值。宿主没有对应运行时实现，但**类型形态必须对齐**，否则上游代码
 * 复制过来编译不过。
 *
 * ## 从哪来的形态
 *
 * 逐条照抄上游 `apps/desktop/src/sdk/index.ts` 与
 * `apps/desktop/src/store/gateway.ts` 的类型定义，只保留 bots 实际用到的字段。
 */

/** 网关 RPC 事件（上游 `store/gateway.ts` 的 socket 事件）。 */
export interface RpcEvent {
  /** 事件类型（`session.event` / `approval.request` / …）。 */
  type: string
  /** 会话运行时 id。 */
  sessionId?: null | string
  /** 事件载荷。 */
  payload?: unknown
  /** 事件序号（重放用）。 */
  seq?: number
}

/** 上游 `PluginContext`：插件注册时拿到的上下文。 */
export interface PluginContext {
  /** 注册一个贡献。 */
  register: (contribution: unknown) => () => void
  /** 插件命名空间存储。 */
  storage: {
    get: <T>(key: string, fallback: T) => T
    set: (key: string, value: unknown) => void
    remove: (key: string) => void
  }
  /** 卸载回调。 */
  onDispose: (fn: () => void) => void
  /** 插件 i18n。 */
  /**
   * 插件 i18n：`register` 注入语言包，`t` 翻译。
   *
   * 上游 `ctx.i18n` 两件事都有（`plugin.tsx:122` 调 `register`，
   * `canonical-chat.ts:444` 调 `t`）。宿主单语言包，`t` 直接回 key。
   */
  i18n?: {
    register: (bundles: Record<string, unknown>) => void
    t?: (key: string, vars?: Record<string, unknown>) => string
  }
  /** OS 门（打开外链等）。 */
  os?: { openExternal: (url: string) => Promise<boolean> }
}

/** 上游 `ChatEmptyProps`：聊天空态的 props。 */
export interface ChatEmptyProps {
  /** 是否首次进入。 */
  firstRun?: boolean
  /** 点击建议时的回调。 */
  onSuggest?: (text: string) => void
}

/** 上游 `ProfileGroupRoute`：profile 分组路由。 */
export interface ProfileGroupRoute {
  /** 分组 id。 */
  groupId: string
  /** 该组下的 profile 列表。 */
  profiles: string[]
}

/** 上游 `PluginProfileRoute`：单个 profile 路由。 */
export interface PluginProfileRoute {
  /** profile 名。 */
  profile: string
  /** 连接 id（多网关时用于区分同名 profile）。 */
  connectionId?: null | string
}

/**
 * 上游 `DisplayLease`：远程显示器租约（screen-portal / screen-connection 用）。
 *
 * 字段集按上游 `hosted_room_driver` / `display` 协议补齐（`holder` / `viewer_hash` /
 * `epoch` / `reason` 都是协议必需）。末尾的索引签名兜住协议后续扩展——
 * 上游是动态 JSON，静态窄化只会让字段逐个补。
 */
export interface DisplayLease {
  /** 租约 id。 */
  leaseId?: string
  /** 过期时刻（毫秒时间戳）。 */
  expiresAt?: number
  /** 持有者（网关 id 或进程代）。 */
  holder?: string
  /** 观看者哈希（防串流）。 */
  viewer_hash?: string
  /** 归属代际。 */
  epoch?: number
  /** 拒绝原因。 */
  reason?: string
  [key: string]: unknown
}

/**
 * 上游 `DisplayStatus`：显示器状态（screen-install / screen-state / screen-pane 用）。
 *
 * 字段集按上游 display 协议补齐：`available`/`blocker`/`counts`/`detail`/
 * `display`/`elapsedS`/`geometry`/`image_switch`/`install_command`/`installed`/
 * `kind`/`label`/`profile_key` 都在协议里。索引签名兜住扩展。
 */
export interface DisplayStatus {
  /** 是否就绪。 */
  ready?: boolean
  /** 是否可用。 */
  available?: boolean
  /** 阻塞原因。 */
  blocker?: null | string
  /** 计数（在线/总数）。 */
  counts?: Record<string, number>
  /** 明细文案。 */
  detail?: null | string
  /** 显示器标识。 */
  display?: null | string
  /** 已运行秒数。 */
  elapsedS?: number
  /** 几何（宽高/坐标）。 */
  geometry?: Record<string, number>
  /** 镜像切换状态。 */
  image_switch?: null | string
  /** 安装命令（未安装时给出）。 */
  install_command?: null | string
  /** 是否已安装。 */
  installed?: boolean
  /** 类型。 */
  kind?: string
  /** 标签。 */
  label?: null | string
  /** 归属 profile 键。 */
  profile_key?: null | string
  /** 当前租约。 */
  lease?: null | DisplayLease
  [key: string]: unknown
}

/** 上游 `DisplayObserveResult`：观察结果。 */
export interface DisplayObserveResult {
  /** 帧数据（base64）。 */
  frame?: string
  /** 状态。 */
  status: DisplayStatus
}

/** 上游 `DisplayThumbnailResult`：缩略图结果。 */
export interface DisplayThumbnailResult {
  /** 缩略图（base64）。 */
  thumbnail?: null | string
}

/** 上游 `SessionListRow`：会话行（花名册/会话列表共用）。 */
export interface SessionListRow {
  /** 存储 id。 */
  storedSessionId: string
  /** 显示名。 */
  name?: null | string
  /** 所属 profile。 */
  profile?: null | string
  /** 更新时间。 */
  updatedAt?: number
  /** 是否进行中。 */
  running?: boolean
}

/** 上游 `ProfileSessionPreview`：profile 下的会话预览。 */
export interface ProfileSessionPreview {
  /** 会话 id。 */
  sessionId: string
  /** 标题。 */
  title?: null | string
}

/** 上游 `ProfilesCreateResult`：创建 profile 的结果。 */
export interface ProfilesCreateResult {
  /** 新 profile 名。 */
  profile: string
  /** 是否已存在（幂等）。 */
  existed?: boolean
}

/** 上游 `PluginOpenSessionOptions`：打开会话的选项。 */
export interface PluginOpenSessionOptions {
  /** 打开后是否聚焦。 */
  focus?: boolean
  /** 是否新建标签。 */
  newTab?: boolean
}

/** 上游 `PluginNewChatOptions`：新建聊天的选项。 */
export interface PluginNewChatOptions {
  /** 工作区模式。 */
  workspaceMode?: 'bots' | 'default'
  /** 工作区 owner 键。 */
  workspaceOwnerKey?: string
}

/** 上游 `PetSayOptions` / `PluginNativeNotificationInput` 等仅被少数文件引用。 */
export interface PetSayOptions {
  text: string
  tone?: string
}

export interface PluginNativeNotificationInput {
  title: string
  body?: string
  kind?: string
}
