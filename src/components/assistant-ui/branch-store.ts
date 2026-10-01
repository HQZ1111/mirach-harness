/**
 * 分支桥（会话 fork / 兄弟分支切换，L1 可见性）：
 * - 投影：refresh() 拉 pi_list_sibling_branches + pi_get_fork_points →
 *   branches / forkPoints。消费方：thread.aui 的 BranchPickerBar（分支
 *   切换条渲染）与 UserActionBar（「从此分支探索」钮可用性——fork 点只在
 *   已水合/已落盘的 user 消息上存在，清单缺失 = 钮禁用，诚实不假装可点）。
 *   拉取时机 = BranchPickerBar 挂载 + refreshSeq 变化；runtime 关键路径
 *   （onReload / onEdit / fork / switch_branch / 会话切换 / run 收尾）成功后
 *   requestRefresh()。
 * - 请求（UI → runtime）：forkRequest / switchRequest 由 runtime.tsx 的
 *   订阅 effect 串行执行——执行需要 actorRef / 水合通道 / currentThreadId
 *   （只在 runtime 有）；执行完 clearXxx(seq)。
 * - composer 预填：fork 成功的 selectedText 经 composerPrefill 传给
 *   composer-wired（走既有 value 控制通道 unstable_useComposerInput.setText
 *   消费，seq 防重复应用），不开新管道。
 * 真相在 pi（活动会话文件/分支树），store 只持投影与信令。zustand vanilla
 * 模式（createStore + useStore 订阅），照抄 connection-store / approval-bridge。
 */
import { invoke } from '@tauri-apps/api/core'
import { createStore, useStore } from 'zustand'

/** pi_list_sibling_branches 行（兄弟分支） */
export interface BranchRow {
  rootId: string
  leafId: string
  preview: string
  messageCount: number
  isCurrent: boolean
}

/** pi_list_sibling_branches 返回形状；null = 无分支（含无活动会话） */
export interface SiblingBranches {
  forkPointId: string | null
  branches: BranchRow[]
}

/** pi_get_fork_points 行：活动会话路径上的 user 消息（有序）——与前端
 * thread 里的 user 消息按顺序一一对应（同源水合+流式追加），index 映射键 */
export interface ForkPoint {
  entryId: string
  text: string
}

/** UI 投递的 fork 请求（runtime 执行器消费） */
export interface ForkRequest {
  seq: number
  /** 第 N 条 user 消息（0 起）——pi_get_fork_points 清单的下标 */
  userOrdinal: number
  /** 该消息的投影文本（与 fork 点 text 比对，防投影与 pi 路径漂移） */
  expectText: string
}

/** UI 投递的分支切换请求（runtime 执行器消费） */
export interface SwitchRequest {
  seq: number
  leafId: string
}

/** fork 成功后写入的 composer 预填（selectedText；composer-wired 消费） */
export interface ComposerPrefill {
  seq: number
  text: string
}

/** pi_get_session_lineage：当前会话的 fork 谱系——branchedFrom = 父会话
 * 文件路径（SessionHeader.parent_session）；线性会话 = null（不渲染会话线） */
export interface SessionLineage {
  branchedFrom: string | null
}

/** pi_get_session_lineage 返回解析：Tauri 命令返回**裸 Option<String>**——
 * string = 父会话文件路径、null = 线性会话；也兼容 {branchedFrom} 包裹
 * 形（防 Rust 侧日后改包结构）。其余形状 console.error + null。 */
export const parseSessionLineage = (raw: unknown): SessionLineage | null => {
  if (raw === null) return { branchedFrom: null }
  if (typeof raw === 'string') return { branchedFrom: raw }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const b = (raw as { branchedFrom?: unknown }).branchedFrom
    if (b === null || typeof b === 'string') return { branchedFrom: b }
  }
  console.error('[branch] pi_get_session_lineage 形状非法——丢弃', raw)
  return null
}

/** UI 投递的「回到父会话」请求（runtime 执行器消费；按路径 open_session） */
export interface OpenParentRequest {
  seq: number
  path: string
}

const asString = (v: unknown): string | null =>
  typeof v === 'string' ? v : null

/** 严格解析 pi_list_sibling_branches 返回：整体形状不符 → console.error +
 * null（不渲染）；单行字段缺失 → console.error + 跳过该行（选择走 leafId
 * 自洽映射，跳行不错位）。null 合法（无分支）。 */
export const parseSiblingBranches = (raw: unknown): SiblingBranches | null => {
  if (raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    console.error('[branch] pi_list_sibling_branches 形状非法——丢弃', raw)
    return null
  }
  const r = raw as { forkPointId?: unknown; branches?: unknown }
  if (!Array.isArray(r.branches)) {
    console.error('[branch] pi_list_sibling_branches.branches 非数组——丢弃', raw)
    return null
  }
  const branches: BranchRow[] = []
  for (const item of r.branches) {
    if (typeof item !== 'object' || item === null) {
      console.error('[branch] 分支行形状非法——跳过', item)
      continue
    }
    const b = item as Record<string, unknown>
    const rootId = asString(b.rootId)
    const leafId = asString(b.leafId)
    const preview = asString(b.preview)
    if (
      rootId === null ||
      leafId === null ||
      preview === null ||
      typeof b.messageCount !== 'number' ||
      !Number.isFinite(b.messageCount)
    ) {
      console.error('[branch] 分支行字段缺失/非法——跳过', item)
      continue
    }
    branches.push({
      rootId,
      leafId,
      preview,
      messageCount: b.messageCount,
      isCurrent: b.isCurrent === true,
    })
  }
  const forkPointId =
    r.forkPointId === null || typeof r.forkPointId === 'string'
      ? r.forkPointId
      : null
  if (forkPointId === null && r.forkPointId !== null) {
    console.error('[branch] forkPointId 类型非法（按 null 处理）——可见', r.forkPointId)
  }
  return { forkPointId, branches }
}

/** 严格解析 pi_get_fork_points 返回。清单与 thread 的 user 消息按序一一
 * 对应（index 是 fork 映射键）——任何一行缺失都会让后续下标错位，故
 * 整份丢弃（诚实：全部 fork 钮禁用）而非错位映射。 */
export const parseForkPoints = (raw: unknown): ForkPoint[] => {
  if (!Array.isArray(raw)) {
    console.error('[branch] pi_get_fork_points 返回非数组——清单丢弃', raw)
    return []
  }
  const out: ForkPoint[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i]
    if (typeof item !== 'object' || item === null) {
      console.error(`[branch] fork 点第 ${i} 行形状非法——整份清单丢弃`, item)
      return []
    }
    const p = item as Record<string, unknown>
    const entryId = asString(p.entryId)
    const text = asString(p.text)
    if (entryId === null || text === null) {
      console.error(`[branch] fork 点第 ${i} 行字段缺失/非法——整份清单丢弃`, item)
      return []
    }
    out.push({ entryId, text })
  }
  return out
}

/** SiblingBranches → MessageBranches 模板 props：variants = 各分支 preview、
 * index = isCurrent 分支位（缺失落 0，prev/next 仍可用）。纯函数可单测。 */
export const toBranchPickerView = (
  sb: SiblingBranches,
): { variants: readonly string[]; index: number } => {
  const idx = sb.branches.findIndex((b) => b.isCurrent)
  return { variants: sb.branches.map((b) => b.preview), index: idx >= 0 ? idx : 0 }
}

/** 请求序号（模块级单调——fork/switch/预填共用一个单调源，执行器的
 * handled-seq 防重与 busy 锁都依赖单调性） */
let requestSeq = 0
const nextSeq = () => ++requestSeq

interface BranchBridgeState {
  /** 分支切换条投影；null = 无分支/无活动会话/拉取失败（不渲染） */
  branches: SiblingBranches | null
  /** fork 点清单投影（与 thread user 消息按序对应）；[] = 无可 fork 点 */
  forkPoints: ForkPoint[]
  /** 会话线谱系投影；branchedFrom != null = 当前会话是 fork 子会话 */
  lineage: SessionLineage | null
  /** 刷新信号：requestRefresh 递增，BranchPickerBar 订阅后重拉 */
  refreshSeq: number
  requestRefresh: () => void
  refresh: () => Promise<void>
  forkRequest: ForkRequest | null
  requestFork: (userOrdinal: number, expectText: string) => void
  clearForkRequest: (seq: number) => void
  switchRequest: SwitchRequest | null
  requestSwitch: (leafId: string) => void
  clearSwitchRequest: (seq: number) => void
  openParentRequest: OpenParentRequest | null
  requestOpenParent: (path: string) => void
  clearOpenParentRequest: (seq: number) => void
  composerPrefill: ComposerPrefill | null
  setComposerPrefill: (text: string) => void
}

export const branchBridge = createStore<BranchBridgeState>(() => ({
  branches: null,
  forkPoints: [],
  lineage: null,
  refreshSeq: 0,
  requestRefresh: () =>
    branchBridge.setState((s) => ({ refreshSeq: s.refreshSeq + 1 })),
  refresh: async () => {
    try {
      const [rawBranches, rawPoints, rawLineage] = await Promise.all([
        invoke<unknown>('pi_list_sibling_branches'),
        invoke<unknown>('pi_get_fork_points'),
        invoke<unknown>('pi_get_session_lineage'),
      ])
      branchBridge.setState({
        branches: parseSiblingBranches(rawBranches),
        forkPoints: parseForkPoints(rawPoints),
        lineage: parseSessionLineage(rawLineage),
      })
    } catch (e) {
      if (String(e).includes('no active session')) {
        // 首启 / New Chat / 删除活动会话后的预期域状态：无会话 = 无分支、
        // 无 fork 点、无谱系——清投影不算错误
        branchBridge.setState({
          branches: null,
          forkPoints: [],
          lineage: null,
        })
        return
      }
      // 真错误：console.error 可见 + 清投影（未知状态不冒充旧会话的数据）
      console.error('[branch] 分支数据拉取失败——清投影', e)
      branchBridge.setState({
        branches: null,
        forkPoints: [],
        lineage: null,
      })
    }
  },
  forkRequest: null,
  requestFork: (userOrdinal, expectText) =>
    branchBridge.setState({
      forkRequest: { seq: nextSeq(), userOrdinal, expectText },
    }),
  clearForkRequest: (seq) =>
    branchBridge.setState((s) =>
      s.forkRequest?.seq === seq ? { forkRequest: null } : {},
    ),
  switchRequest: null,
  requestSwitch: (leafId) =>
    branchBridge.setState({ switchRequest: { seq: nextSeq(), leafId } }),
  clearSwitchRequest: (seq) =>
    branchBridge.setState((s) =>
      s.switchRequest?.seq === seq ? { switchRequest: null } : {},
    ),
  openParentRequest: null,
  requestOpenParent: (path) =>
    branchBridge.setState({ openParentRequest: { seq: nextSeq(), path } }),
  clearOpenParentRequest: (seq) =>
    branchBridge.setState((s) =>
      s.openParentRequest?.seq === seq ? { openParentRequest: null } : {},
    ),
  composerPrefill: null,
  setComposerPrefill: (text) =>
    branchBridge.setState({ composerPrefill: { seq: nextSeq(), text } }),
}))

export const useBranchBridge = () => useStore(branchBridge)
