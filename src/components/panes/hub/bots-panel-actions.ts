/**
 * 机器人弹出栏的布局动作（2026-11-07 完整移植 hermes 机器人页）：
 * Mirach 点击 = 在左栏右侧弹出/收起「机器人」栏（hermes 的 Bots pane 是
 * 左栏区里 SESSIONS|BOTS 页签；宿主按用户口径改为**独立栏**——"在左侧栏
 * 的右边弹出一个栏显示"）。
 *
 * 面板 = dockview 面板（id 'bots'，region 'bots'——**不是** 'panels'：
 * 面板栏的生命周期语义 [末签关闭关栏/锚重建] 不适用于本栏）。持久化 =
 * 布局存档自然携带（dockview 序列化所有面板），重开应用保持上次开合态。
 *
 * api 取用走 `__dvApi` 调试句柄（conversation-status-panel 的 openPagePanel
 * 同款先例——leftrail 内容组件拿不到 containerApi，全局句柄是既有通道）。
 */
import { createStore, useStore } from 'zustand'
import type { DockviewApi } from 'dockview-react'

export const BOTS_PANEL_ID = 'bots'
/** 弹出栏宽度（hermes BotsPane 260px 同值；面板级 min/max 夹取）。 */
export const BOTS_PANE_WIDTH = 260
export const BOTS_PANE_MIN_WIDTH = 240
export const BOTS_PANE_MAX_WIDTH = 360

interface BotsPanelState {
  /** 面板在场（shell 的 didAdd/didRemove 同步——✕ 关闭也走这条）。 */
  open: boolean
  setOpen: (open: boolean) => void
}

export const botsPanelStore = createStore<BotsPanelState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

/** React 订阅（Mirach 按钮态）。 */
export const useBotsPanelOpen = (): boolean => useStore(botsPanelStore, (s) => s.open)

function apiOf(): DockviewApi | null {
  return (globalThis as { __dvApi?: DockviewApi }).__dvApi ?? null
}

function addBotsPanel(a: DockviewApi): void {
  a.addPanel({
    id: BOTS_PANEL_ID,
    component: 'bots',
    title: '机器人',
    minimumWidth: BOTS_PANE_MIN_WIDTH,
    maximumWidth: BOTS_PANE_MAX_WIDTH,
    params: { region: 'bots' },
    // 左栏右侧：leftrail 面板缺失（异常存档）时回退主栏左侧
    position: { referencePanel: 'leftrail', direction: 'right' },
  })
  // 钉回目标宽（addPanel 的对半分宽会超 max——实测 429 > 360；constraint
  // 只在 distribute 时生效，钉宽照 rail repin 同思路）
  const panel = a.getPanel(BOTS_PANEL_ID)
  if (panel) {
    try {
      panel.api.setSize({ width: BOTS_PANE_WIDTH })
    } catch (e) {
      console.error('[bots] 钉宽失败（保持对半分宽）', e)
    }
  }
}

/** Mirach 点击：开合切换。 */
export function toggleBotsPanel(): void {
  const a = apiOf()
  if (!a) {
    console.error('[bots] 布局 api 不在场——机器人栏开合放弃')
    return
  }
  const existing = a.getPanel(BOTS_PANEL_ID)
  if (existing) {
    a.removePanel(existing)
    return
  }
  addBotsPanel(a)
}

/** 打开机器人栏（幂等；档案栏「管理机器人」/「+」入口用——hermes
 *  导航到配置文件页的对偶，不因已开而关掉）。 */
export function openBotsPanel(): void {
  const a = apiOf()
  if (!a) {
    console.error('[bots] 布局 api 不在场——机器人栏打开放弃')
    return
  }
  if (a.getPanel(BOTS_PANEL_ID)) return
  addBotsPanel(a)
}

export function syncBotsPanelOpen(): void {
  const a = apiOf()
  if (!a) return
  botsPanelStore.getState().setOpen(a.getPanel(BOTS_PANEL_ID) !== undefined)
}

/** 关闭机器人栏（插件停用/启动 gate 关闭时调用）。 */
export function closeBotsPanel(): void {
  const a = apiOf()
  if (!a) return
  for (const id of [BOTS_PANEL_ID, 'routines']) {
    const panel = a.getPanel(id)
    if (panel) a.removePanel(panel)
  }
}
