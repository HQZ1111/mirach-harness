/**
 * 检查点桥（pi checkpoint/rewind 命令面，对话历史编辑）：
 * - 投影：refresh() 拉 pi_list_checkpoints（当前会话活动路径上的 checkpoint
 *   Custom 条目枚举）→ checkpoints。消费方 = thread.aui 的 CheckpointBar
 *   弹出面板（打检查点 / 回到此点）。
 * - 请求（UI → runtime）：rewindRequest 由 runtime.tsx 的订阅 effect 串行
 *   执行（branch-store 同款通道）——回退需要 interruptIfRunning 守卫与
 *   HYDRATE 重水合通道（只在 runtime 手里）；执行完 clearRewindRequest(seq)。
 * - currentId：本进程内最近一次成功回退到的检查点名（会话域状态——会话
 *   更换时 runtime 调 resetProjection 清掉；进程重启不保留）。
 * 真相在 pi（会话树 Custom 条目），store 只持投影与信令。zustand vanilla
 * 模式，照抄 branch-bridge / connection-store。
 */
import { invoke } from '@tauri-apps/api/core'
import { createStore, useStore } from 'zustand'

/** pi_list_checkpoints 行（pi_session.rs list_checkpoints 逐字段实锤）：
 * entryId 是宿主手工带的会话树条目 id（可能为 null）；name 是 pi_rewind
 * 的查找键（反向扫活动路径取最新同名）。 */
export interface CheckpointRow {
  entryId: string | null
  name: string
  note: string | null
  tokenEstimate: number
  messageCount: number
  atMs: number
}

/** UI 投递的回退请求（runtime 执行器消费） */
export interface RewindRequest {
  seq: number
  /** 检查点名称（pi find_checkpoint 的匹配键——不是 entryId） */
  name: string
}

const asString = (v: unknown): string | null =>
  typeof v === 'string' ? v : null

const asFiniteNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

/** 严格解析 pi_list_checkpoints 返回（裸数组）：行与行之间无索引依赖
 * （name 即查找键），单行字段缺失 → console.error + 跳过该行；整体非数组
 * → console.error + []（不渲染）。 */
export const parseCheckpoints = (raw: unknown): CheckpointRow[] => {
  if (!Array.isArray(raw)) {
    console.error('[checkpoint] pi_list_checkpoints 返回非数组——清单丢弃', raw)
    return []
  }
  const out: CheckpointRow[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) {
      console.error('[checkpoint] 检查点行形状非法——跳过', item)
      continue
    }
    const r = item as Record<string, unknown>
    const name = asString(r.name)
    const tokenEstimate = asFiniteNumber(r.tokenEstimate)
    const messageCount = asFiniteNumber(r.messageCount)
    const atMs = asFiniteNumber(r.atMs)
    if (
      name === null ||
      tokenEstimate === null ||
      messageCount === null ||
      atMs === null
    ) {
      console.error('[checkpoint] 检查点行字段缺失/非法——跳过', item)
      continue
    }
    // entryId/note 本就可空（Option）：null 之外的非法类型按 null 处理并可见
    const entryId = asString(r.entryId)
    if (r.entryId !== null && entryId === null) {
      console.error('[checkpoint] 检查点 entryId 类型非法（按 null 处理）——可见', r.entryId)
    }
    const note = asString(r.note)
    if (r.note !== null && note === null) {
      console.error('[checkpoint] 检查点 note 类型非法（按 null 处理）——可见', r.note)
    }
    out.push({ entryId, name, note, tokenEstimate, messageCount, atMs })
  }
  return out
}

/** 检查点时间展示（面板行）：MM-DD HH:mm（24h）；非法时间戳 → "—" */
export const formatCheckpointTime = (atMs: number): string => {
  const d = new Date(atMs)
  if (Number.isNaN(d.getTime())) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
}

/** 请求序号（模块级单调——与 branch-bridge 的 seq 源独立，执行器的
 * handled-seq 防重与 busy 锁各自依赖各自的单调性） */
let rewindSeq = 0

interface CheckpointBridgeState {
  /** 检查点投影；[] = 无检查点/无活动会话/拉取失败（面板显示空态） */
  checkpoints: CheckpointRow[]
  refresh: () => Promise<void>
  rewindRequest: RewindRequest | null
  requestRewind: (name: string) => void
  clearRewindRequest: (seq: number) => void
  /** 本进程内最近一次成功回退到的检查点名（null = 无回退史） */
  currentId: string | null
  /** 会话更换时清会话域投影（checkpoints + currentId） */
  resetProjection: () => void
}

export const checkpointBridge = createStore<CheckpointBridgeState>((set) => ({
  checkpoints: [],
  refresh: async () => {
    try {
      const raw = await invoke<unknown>('pi_list_checkpoints')
      set({ checkpoints: parseCheckpoints(raw) })
    } catch (e) {
      if (String(e).includes('no active session')) {
        // 首启 / New Chat / 删除活动会话后的预期域状态：无会话 = 无检查点
        set({ checkpoints: [] })
        return
      }
      // 真错误：console.error 可见 + 清投影（未知状态不冒充旧数据）
      console.error('[checkpoint] 检查点清单拉取失败——清投影', e)
      set({ checkpoints: [] })
    }
  },
  rewindRequest: null,
  requestRewind: (name) =>
    set({ rewindRequest: { seq: ++rewindSeq, name } }),
  clearRewindRequest: (seq) =>
    set((s) => (s.rewindRequest?.seq === seq ? { rewindRequest: null } : {})),
  currentId: null,
  resetProjection: () =>
    set({ checkpoints: [], currentId: null }),
}))

export const useCheckpointBridge = () => useStore(checkpointBridge)
