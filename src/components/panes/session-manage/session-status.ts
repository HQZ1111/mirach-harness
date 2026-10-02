/**
 * 会话状态桶（hermes store/session-dot-state.ts 的 SessionStatusBucket 段
 * + app/chat/session-status-dot.tsx 的 DOT_VARIANTS 色/形，逐语义照抄）。
 *
 * hermes 五桶（session-dot-state.ts:84）：draft | idle | needs-input |
 * unread | working——stalled/background 折进 working（:86-87）。排名表
 * ：needs-input 0（最响）→ working 1 → unread 2 → draft 3 → idle 4
 * （:89-95，"Loudest first"）。
 *
 * pi 数据面（无服务端状态桶，前端全可判定）：
 * - needs-input = 审批卡挂起（approvalBridge.pending 非空，pi 的 extension
 *   请求只发生在当前活跃会话 → 挂在 mainThreadId）；
 * - working = runtime isRunning 的当前活跃会话；
 * - unread = 客户端未读水位（session-unread isRowUnread）；
 * - draft = 新会话无消息（messageCount 缺省/0——pi SessionMeta.messageCount
 *   的直投影）；
 * - idle = 其余。
 *
 * 优先级链 = hermes claim 顺序翻转（session-dot-state.ts:131-180）：
 * attention(needs-input) 最响 > working > unread > draft > idle。
 *
 * 色点 = hermes session-status-dot.tsx DOT_VARIANTS：needs-input 琥珀实心
 * （bg-amber-500 原样——hermes 字面色）、working 品牌蓝（--fl-accent）、
 * unread 成功绿（--success）、draft 空心弱描边（quaternary）、idle 最淡
 * 小实心（size-1）。填充 = 产出中，空心 = 开着但安静（hermes 同款语义）。
 */

/** 侧栏状态筛选与状态排序工作的桶（hermes session-dot-state.ts:84）。 */
export type SessionStatusBucket = 'draft' | 'idle' | 'needs-input' | 'unread' | 'working'

/** 行参与状态判定/排序的输入（pi 直投影子集）。 */
export interface SessionStatusSignals {
  /** 审批/问题卡挂起且挂在该会话（pi：extension 请求 = 活跃会话）。 */
  readonly needsInput: boolean
  /** 会话正在跑（runtime isRunning + mainThreadId）。 */
  readonly running: boolean
  /** 未读（客户端水位 isRowUnread）。 */
  readonly unread: boolean
  /** 新会话无消息（messageCount 缺省/0）。 */
  readonly draft: boolean
}

/** 状态排序表（hermes session-dot-state.ts:89-95 原样——最响在前）。 */
export const STATUS_RANK: Readonly<Record<SessionStatusBucket, number>> = {
  'needs-input': 0,
  working: 1,
  unread: 2,
  draft: 3,
  idle: 4,
}

/** 排序键（升序即最响最先——hermes sessionStatusRank 同构）。 */
export const sessionStatusRank = (bucket: SessionStatusBucket): number => STATUS_RANK[bucket]

/**
 * 五桶判定（纯函数）：优先级链 hermes claim 顺序——draft 最弱（"no turn has
 * happened here yet"，任何发生的事都能盖过它）、attention 最强（唯一需要
 * 用户动手的状态）。同序信号不打架：needsInput > running > unread > draft
 * > idle。
 */
export function sessionStatusBucket(signals: SessionStatusSignals): SessionStatusBucket {
  if (signals.needsInput) return 'needs-input'
  if (signals.running) return 'working'
  if (signals.unread) return 'unread'
  if (signals.draft) return 'draft'
  return 'idle'
}

/** 桶的中文名（菜单子项/分组分隔线共用；用户截图措辞）。 */
export const STATUS_BUCKET_LABELS: Readonly<Record<SessionStatusBucket, string>> = {
  'needs-input': '需要输入',
  working: '运行中',
  unread: '未读',
  draft: '草稿',
  idle: '空闲',
}

/** 菜单色点的完整 className（hermes sessionDotClassName 的等价物）。
 *  色值引用既有令牌（--fl-accent/--success/--text-4）；needs-input 的琥珀
 *  沿用 hermes 字面色 bg-amber-500（tokens.css 无琥珀令牌，hermes 原样）。 */
export const STATUS_DOT_CLASS: Readonly<Record<SessionStatusBucket, string>> = {
  'needs-input': 'size-1.5 rounded-full bg-amber-500',
  working: 'size-1.5 rounded-full bg-(--fl-accent)',
  unread: 'size-1.5 rounded-full bg-(--success)',
  draft: 'size-1.5 rounded-full border border-(--text-4)',
  idle: 'size-1 rounded-full bg-(--text-4)',
}
