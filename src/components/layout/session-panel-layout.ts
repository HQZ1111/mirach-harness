/**
 * 每会话右侧面板布局（ZCode side pane / hermes preview tabs 的宿主对偶，
 * 2026-11-28）。
 *
 * 事实依据（研究结论，来源见 docs 交接）：
 * - ZCode：side pane tab 带 owner 戳，`isSidePaneTabVisibleInScope` 按会话
 *   过滤可见性；切会话 = 换抽屉（tab 集合是 workspace 级内存池，但归属/
 *   折叠按 owner）。
 * - hermes：`PreviewTab.sessionId` + `pinned`；`$visiblePreviewTabs` 只渲染
 *   焦点会话的签（"a session switch swaps the drawer; hidden tabs stay"）。
 *
 * 宿主此前只有一份全局 dockview 存档（`mirach.harness.layout.v10`）：切会话
 * 时预览/终端/审查面板原样留在栏里，内容却不属于新会话。这里补上"抽屉"：
 * - **几何/栏宽/开合** 仍是全局（v10 + colflags；hermes 的 paneStates 同为
 *   全局偏好）——只换面板集合，栏不跳位；
 * - **会话域面板集合**按会话持久化（localStorage，LRU 50）：
 *   preview* / review / terminal* / subagent / plan-detail / agent-directory /
 *   workflow-run*；
 * - **全局面板**（files 文件树 / routines 例程 / radio 电台 / bots 机器人栏 /
 *   open 锚 / plugin-workspace 群聊房间）不参与换抽屉；
 * - 新会话（无记录）= 空抽屉（hermes 新会话没有 tab）；首次切换时把当前
 *   集合记到**切走的那个会话**名下（种子来自 boot 存档）。
 *
 * 不落盘的大参数面板（subagent/plan-detail 的 payload 等对象参数）：如实
 * console.info 跳过该面板的持久化（hermes `persistableTabs` 同思路），
 * 面板本身不关，只是不跨会话/重启恢复。
 */
import type { DockviewApi, IDockviewPanel } from 'dockview-react'

import { isTerminalPanelId } from '@/components/panes/terminal/terminal-tabs'
import { panelsDropPosition } from './open-page-actions'
import { RAIL_MAX_WIDTH, RAIL_MIN_WIDTH } from './rail-metrics'

/** 会话域面板存档键（与 v10 布局档分离：几何仍归 v10）。 */
export const PANEL_LAYOUT_KEY = 'mirach.harness.panelLayout.v1'
/** 记录的会话上限（LRU，thread-scroll 同量级）。 */
export const SESSION_PANEL_LIMIT = 50
/** 单面板 params 的 JSON 上限（超过 = 不持久化该面板）。 */
const MAX_DESCRIPTOR_JSON = 8 * 1024
/** 单会话记录总 JSON 上限（超限丢最大的描述符）。 */
const MAX_SESSION_JSON = 32 * 1024

export interface SessionPanelDescriptor {
  id: string
  component: string
  title?: string
  params?: Record<string, unknown>
  /** 切走时它是否是激活签（回来时恢复）。 */
  active?: boolean
}

interface PanelLayoutStore {
  ver: 1
  /** LRU 顺序（末尾最新）。 */
  order: string[]
  bySession: Record<string, SessionPanelDescriptor[]>
}

/** 会话域面板判据（不在此列 = 全局面板，换抽屉不动它）。 */
export function isSessionScopedPanel(panel: IDockviewPanel): boolean {
  const id = panel.id
  return (
    id === 'preview' ||
    id.startsWith('preview:') ||
    id === 'review' ||
    isTerminalPanelId(id) ||
    id === 'subagent' ||
    id === 'plan-detail' ||
    id === 'agent-directory' ||
    id === 'workflow-run' ||
    id.startsWith('workflow-run:')
  )
}

const emptyStore = (): PanelLayoutStore => ({ ver: 1, order: [], bySession: {} })

const loadStore = (): PanelLayoutStore => {
  try {
    const raw = localStorage.getItem(PANEL_LAYOUT_KEY)
    if (!raw) return emptyStore()
    const parsed = JSON.parse(raw) as PanelLayoutStore
    if (parsed?.ver !== 1 || typeof parsed.bySession !== 'object' || !Array.isArray(parsed.order)) {
      console.error('[panel-layout] 存档形状不对——按空档处理（旧记录被忽略）', parsed)
      return emptyStore()
    }
    return parsed
  } catch (e) {
    console.error('[panel-layout] 存档解析失败——按空档处理', e)
    return emptyStore()
  }
}

const saveStore = (store: PanelLayoutStore): void => {
  try {
    localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify(store))
  } catch (e) {
    console.error('[panel-layout] 存档写入失败（每会话抽屉将丢失）', e)
  }
}

/** 读取某会话的面板集合（无记录 = null，调用方按空抽屉处理）。 */
export function loadSessionPanels(sessionId: string): SessionPanelDescriptor[] | null {
  const store = loadStore()
  const hit = store.bySession[sessionId]
  return hit ? hit : null
}

/** 写某会话的面板集合（LRU：先删后插，超限淘汰最旧）。 */
export function saveSessionPanels(
  sessionId: string,
  panels: readonly SessionPanelDescriptor[],
): void {
  const store = loadStore()
  // 单会话上限：从最大开始丢，直到总长回落（描述符已是小参数）。
  let kept = [...panels]
  while (kept.length > 1 && JSON.stringify(kept).length > MAX_SESSION_JSON) {
    let bigIndex = 0
    let bigLen = -1
    kept.forEach((d, i) => {
      const len = JSON.stringify(d).length
      if (len > bigLen) {
        bigLen = len
        bigIndex = i
      }
    })
    console.info(
      `[panel-layout] 会话 ${sessionId} 面板记录超限——丢弃最大一条（${kept[bigIndex]?.id}）`,
    )
    kept = kept.filter((_, i) => i !== bigIndex)
  }
  store.bySession[sessionId] = kept
  store.order = store.order.filter((id) => id !== sessionId)
  store.order.push(sessionId)
  while (store.order.length > SESSION_PANEL_LIMIT) {
    const drop = store.order.shift()
    if (drop !== undefined) delete store.bySession[drop]
  }
  saveStore(store)
}

/** 会话删除时清记录（行删除后抽屉不再需要）。 */
export function deleteSessionPanels(sessionId: string): void {
  const store = loadStore()
  if (!(sessionId in store.bySession) && !store.order.includes(sessionId)) return
  delete store.bySession[sessionId]
  store.order = store.order.filter((id) => id !== sessionId)
  saveStore(store)
}

/**
 * 采集当前布局里会话域面板（切走时调用）。参数含对象/数组（payload）或
 * 超长字符串 = 该面板不可恢复：console.info 可见地跳过。
 */
export function captureSessionPanels(api: DockviewApi): SessionPanelDescriptor[] {
  const out: SessionPanelDescriptor[] = []
  for (const panel of api.panels) {
    if (!isSessionScopedPanel(panel)) continue
    const rawParams = panel.params as Record<string, unknown> | undefined
    let params: Record<string, unknown> | undefined
    let persistable = true
    if (rawParams && typeof rawParams === 'object') {
      params = {}
      for (const [key, value] of Object.entries(rawParams)) {
        const primitive =
          value === null ||
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        if (!primitive) {
          persistable = false
          break
        }
        params[key] = value
      }
    }
    const descriptor: SessionPanelDescriptor = {
      id: panel.id,
      component: panel.view.contentComponent,
      ...(panel.title === undefined ? {} : { title: panel.title }),
      ...(params === undefined ? {} : { params }),
      ...(panel.api.isActive ? { active: true } : {}),
    }
    if (persistable && JSON.stringify(descriptor).length > MAX_DESCRIPTOR_JSON) persistable = false
    if (!persistable) {
      console.info(
        `[panel-layout] 面板 ${panel.id} 参数过大/含对象——不跨会话恢复（面板本身不动）`,
      )
      continue
    }
    out.push(descriptor)
  }
  return out
}

/**
 * 把 api 的会话域面板换成目标会话的抽屉（差量手术，不用 fromJSON：几何
 * 属全局，fromJSON 会把整棵 geom 树换掉 → 栏宽/列序跳动）。
 *
 * 调用方负责在静默窗口内调用（dockview-shell 的 applyingPanelsRef），
 * 本函数只做面板集合的增删 + 锚生命周期。
 */
export function applySessionPanels(api: DockviewApi, sessionId: string): void {
  const want = loadSessionPanels(sessionId) ?? []
  const wanted = new Map(want.map((d) => [d.id, d]))
  // 顺序：**先补开、后摘旧**——先摘会把"只有会话域面板"的栏瞬间掏空，
  // dockview 会收走空组（列消失），后补的 addPanel 只能新建一列（位置/
  // 宽度都不是原来的）。同一同步块里两批共存不会有可见中间态（布局事件
  // 由调用方的静默窗口挡住）。
  // 1) 补开缺的面板（位置语义与打开页动作同源：open 锚/根组在场 → within）
  for (const desc of want) {
    if (api.getPanel(desc.id)) continue
    try {
      const panel = api.addPanel({
        id: desc.id,
        component: desc.component,
        title: desc.title,
        params: { region: 'panels', ...(desc.params ?? {}) },
        minimumWidth: RAIL_MIN_WIDTH,
        maximumWidth: RAIL_MAX_WIDTH,
        position: panelsDropPosition(api),
      })
      // 终端保持挂载（与 open-page-actions 的 openTerminalPanel 同款）。
      if (isTerminalPanelId(desc.id) && panel.api.renderer !== 'always') {
        panel.api.setRenderer('always')
      }
    } catch (e) {
      console.error(`[panel-layout] 恢复面板 ${desc.id} 失败（该签丢失）`, e)
    }
  }
  // 2) 摘掉不在目标集合里的会话域面板（全局面板不动）
  for (const panel of [...api.panels]) {
    if (!isSessionScopedPanel(panel)) continue
    if (wanted.has(panel.id)) continue
    try {
      api.removePanel(panel)
    } catch (e) {
      console.error(`[panel-layout] 关闭面板 ${panel.id} 失败（抽屉切换不完整）`, e)
    }
  }
  // 3) 激活态：记录里标了 active 的签置前（找不到就不动，不猜）。
  const activeDesc = want.find((d) => d.active)
  if (activeDesc) {
    const panel = api.getPanel(activeDesc.id)
    if (panel) {
      try {
        panel.api.setActive()
      } catch (e) {
        console.error(`[panel-layout] 激活面板 ${activeDesc.id} 失败`, e)
      }
    }
  }
  // 4) 锚生命周期：有实签 → 摘掉 open 锚（与 handlePanelAdded 同语义；
  //    调用方静默窗口内跳过了那个钩子，这里补齐）。没有实签时锚留着，
  //    面板栏的开/合由调用方按旗标处理。
  const hasReal = api.panels.some((p) => p.id !== 'open' && p.params?.region === 'panels')
  const open = api.getPanel('open')
  if (hasReal && open) {
    try {
      api.removePanel(open)
    } catch (e) {
      console.error('[panel-layout] 摘除打开页锚失败', e)
    }
  }
}
