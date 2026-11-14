/**
 * 全局快捷键系统（hermes lib/keybinds/actions.ts + store/keybinds.ts 的移植，
 * 2026-10-24；2026-10-24 二轮：注册表扩为 hermes 全表）。
 *
 * ## 存储契约（hermes 同语义，键名换 mirach 前缀）
 *
 * `mirach.desktop.keybinds` = JSON `Record<actionId, string[]>` —— **只存
 * 与默认不同的覆盖**（`[]` = 已清除/未绑定）。组合串 = 小写 `+` 连接的
 * `mod|ctrl|alt|shift+<key>`，`mod` = 主加速键（Windows = Ctrl）；损坏
 * JSON → {}；未知 action id 丢弃；不在存储里的 action 用默认组合。
 *
 * ## 注册表 = hermes actions.ts 全表（60 项 + 只读 14 项）
 *
 * 动作 id / 分类 / 默认组合逐字照抄 hermes（含 tab/profile/session 槽位
 * 生成：mod+1..9 / mod+alt+10..18 / ctrl+1..9）。**wired 标记**是本地
 * 诚实层：harness 当前只有三个动作有全局处理器（global-keybinds.tsx
 * 的 handlers 表）；其余动作保留注册/改绑/冲突检测（数据面全部真实），
 * 行上标「未接线」——不假装按下有行为（铁律 11）。骨架接了新处理器就把
 * 对应行 wired 改 true。
 */

import { create } from 'zustand'

export type KeybindCategory = '输入' | '配置文件' | '会话' | '导航' | '视图'

export interface KeybindAction {
  id: string
  /** 默认组合（canonical 串数组；多值 = 任一命中）。空 = 默认未绑定。 */
  defaults: string[]
  /** 展示名（设置页行标题）。 */
  label: string
  /** 分类（设置页分组标题；hermes 五类的中文对应）。 */
  category: KeybindCategory
  /** 本地扩展：该动作在 harness 是否已有全局处理器（未接线 = 行上标注）。 */
  wired?: boolean
}

/** 槽位组合（hermes comboForSlot：1-9 = mod+N，10-18 = mod+alt+N）。 */
function comboForSlot(slot: number): string {
  return slot <= 9 ? `mod+${slot}` : `mod+alt+${slot}`
}

const SLOT_LABELS_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九']

const tabSlotActions: KeybindAction[] = Array.from({ length: 9 }, (_, i) => ({
  id: `view.tabSlot.${i + 1}`,
  defaults: [comboForSlot(i + 1)],
  label: `切到第${SLOT_LABELS_CN[i]}个标签`,
  category: '视图' as const,
}))

const profileSwitchActions: KeybindAction[] = Array.from({ length: 18 }, (_, i) => ({
  id: `profile.switch.${i + 1}`,
  defaults: [comboForSlot(i + 1)],
  label: `切到配置文件 ${i + 1}`,
  category: '配置文件' as const,
}))

const sessionSlotActions: KeybindAction[] = Array.from({ length: 9 }, (_, i) => ({
  id: `session.slot.${i + 1}`,
  defaults: [`ctrl+${i + 1}`],
  label: `切到会话${SLOT_LABELS_CN[i]}`,
  category: '会话' as const,
}))

export const KEYBIND_ACTIONS: readonly KeybindAction[] = [
  // ── 输入（hermes composer）──
  { id: 'composer.focus', defaults: ['/', 'enter'], label: '聚焦输入框', category: '输入' },
  { id: 'composer.modelPicker', defaults: ['mod+shift+m'], label: '模型选择器', category: '输入' },
  { id: 'composer.voice', defaults: ['mod+alt+v'], label: '语音对话', category: '输入' },
  { id: 'composer.dictate', defaults: [], label: '听写', category: '输入' },
  { id: 'composer.reasoningUp', defaults: [], label: '提高推理等级', category: '输入' },
  { id: 'composer.reasoningDown', defaults: [], label: '降低推理等级', category: '输入' },

  // ── 配置文件（hermes profiles；槽位先于切换器，同 hermes 顺序）──
  ...tabSlotActions,
  { id: 'profile.default', defaults: ['mod+d'], label: '默认配置文件', category: '配置文件' },
  ...profileSwitchActions,
  { id: 'profile.next', defaults: ['mod+shift+]'], label: '下一个配置文件', category: '配置文件' },
  { id: 'profile.prev', defaults: ['mod+shift+['], label: '上一个配置文件', category: '配置文件' },
  { id: 'profile.toggleAll', defaults: ['mod+shift+0'], label: '全部配置文件开关', category: '配置文件' },
  { id: 'profile.create', defaults: [], label: '新建配置文件', category: '配置文件' },

  // ── 会话（hermes session）──
  { id: 'session.new', defaults: ['mod+n'], label: '新建会话', category: '会话', wired: true },
  { id: 'session.newTab', defaults: ['mod+t'], label: '新标签页会话', category: '会话' },
  { id: 'session.newWindow', defaults: ['mod+shift+n'], label: '新窗口会话', category: '会话' },
  { id: 'session.next', defaults: ['ctrl+tab', 'ctrl+pagedown'], label: '下一个会话', category: '会话' },
  { id: 'session.prev', defaults: ['ctrl+shift+tab', 'ctrl+pageup'], label: '上一个会话', category: '会话' },
  ...sessionSlotActions,
  { id: 'session.focusSearch', defaults: ['mod+shift+f'], label: '聚焦会话搜索', category: '会话' },
  { id: 'session.togglePin', defaults: [], label: '置顶 / 取消置顶', category: '会话' },
  { id: 'conversation.scrollPageUp', defaults: ['pageup'], label: '上翻一页', category: '会话' },
  { id: 'conversation.scrollPageDown', defaults: ['pagedown'], label: '下翻一页', category: '会话' },
  { id: 'session.archive', defaults: [], label: '归档会话', category: '会话' },
  { id: 'workspace.newWorktree', defaults: ['mod+shift+b'], label: '新建 worktree', category: '会话' },
  { id: 'workspace.openFolder', defaults: ['mod+o'], label: '打开文件夹', category: '会话' },

  // ── 导航（hermes navigation）──
  { id: 'nav.commandPalette', defaults: ['mod+k', 'mod+p'], label: '命令面板', category: '导航', wired: true },
  { id: 'nav.commandCenter', defaults: ['mod+.'], label: '命令中心', category: '导航' },
  { id: 'nav.settings', defaults: ['mod+,'], label: '打开设置', category: '导航', wired: true },
  { id: 'nav.profiles', defaults: [], label: '配置文件面板', category: '导航' },
  { id: 'nav.capabilities', defaults: [], label: '能力面板', category: '导航' },
  { id: 'nav.messaging', defaults: [], label: '消息面板', category: '导航' },
  { id: 'nav.artifacts', defaults: [], label: '产物面板', category: '导航' },
  { id: 'nav.cron', defaults: [], label: '定时任务面板', category: '导航' },
  { id: 'nav.agents', defaults: [], label: '智能体面板', category: '导航' },

  // ── 视图（hermes view + appearance + 快捷键面板本身）──
  { id: 'view.toggleSidebar', defaults: ['mod+b'], label: '侧栏开关', category: '视图' },
  { id: 'view.cycleSidebarGrouping', defaults: [], label: '切换侧栏分组', category: '视图' },
  { id: 'view.toggleRightSidebar', defaults: ['mod+j'], label: '右侧栏开关', category: '视图' },
  { id: 'view.toggleStatusbar', defaults: ['mod+shift+s'], label: '状态栏开关', category: '视图' },
  { id: 'view.toggleTabStrip', defaults: ['mod+alt+t'], label: '标签条开关', category: '视图' },
  { id: 'view.toggleProfileRail', defaults: [], label: '配置栏开关', category: '视图' },
  { id: 'view.toggleSimpleMode', defaults: [], label: '简单模式', category: '视图' },
  { id: 'view.toggleReview', defaults: ['mod+g'], label: '审阅面板', category: '视图' },
  { id: 'view.showFiles', defaults: [], label: '文件面板', category: '视图' },
  { id: 'view.showBrowser', defaults: ['mod+shift+l'], label: '浏览器面板', category: '视图' },
  { id: 'view.toggleHud', defaults: ['mod+shift+h'], label: 'HUD 模式', category: '视图' },
  { id: 'view.showTerminal', defaults: ['ctrl+`'], label: '显示终端', category: '视图' },
  { id: 'view.newTerminal', defaults: ['ctrl+shift+`'], label: '新建终端', category: '视图' },
  { id: 'view.nextTerminal', defaults: ['ctrl+shift+down'], label: '下一个终端', category: '视图' },
  { id: 'view.prevTerminal', defaults: ['ctrl+shift+up'], label: '上一个终端', category: '视图' },
  { id: 'view.closeTerminal', defaults: ['ctrl+shift+w'], label: '关闭终端', category: '视图' },
  { id: 'view.flipPanes', defaults: ['mod+\\'], label: '翻转窗格', category: '视图' },
  { id: 'view.closeTab', defaults: ['mod+w'], label: '关闭标签', category: '视图' },
  { id: 'view.reopenTab', defaults: ['mod+shift+t'], label: '重开标签', category: '视图' },
  { id: 'view.findInPage', defaults: ['mod+f'], label: '页内查找', category: '视图' },
  { id: 'view.findNext', defaults: [], label: '查找下一个', category: '视图' },
  { id: 'view.findPrevious', defaults: [], label: '查找上一个', category: '视图' },
  { id: 'appearance.toggleMode', defaults: ['shift+x'], label: '明暗切换', category: '视图' },
  { id: 'keybinds.openPanel', defaults: ['mod+/'], label: '快捷键面板', category: '视图' },
]

/** 只读快捷键（hermes KEYBIND_READONLY：固定绑定，设置页只展示）。 */
export interface KeybindReadonly {
  id: string
  keys: readonly string[]
  label: string
  category: KeybindCategory
}

export const KEYBIND_READONLY: readonly KeybindReadonly[] = [
  { id: 'composer.send', keys: ['enter'], label: '发送', category: '输入' },
  { id: 'composer.newline', keys: ['shift+enter'], label: '换行', category: '输入' },
  { id: 'composer.steer', keys: ['enter'], label: '转向', category: '输入' },
  { id: 'composer.queue', keys: ['mod+enter'], label: '排队', category: '输入' },
  { id: 'composer.sendQueued', keys: ['mod+shift+k'], label: '发送排队消息', category: '输入' },
  { id: 'composer.mention', keys: ['@'], label: '提及', category: '输入' },
  { id: 'composer.slash', keys: ['/'], label: '斜杠命令', category: '输入' },
  { id: 'composer.help', keys: ['?'], label: '帮助', category: '输入' },
  { id: 'composer.history', keys: ['up', 'down'], label: '历史记录', category: '输入' },
  { id: 'composer.cancel', keys: ['escape'], label: '取消', category: '输入' },
  { id: 'composer.focus.hard', keys: ['mod+l'], label: '聚焦输入框（硬）', category: '输入' },
  { id: 'view.selectionToComposer', keys: ['mod+l'], label: '选中文本进输入框', category: '视图' },
  { id: 'view.terminalCopy', keys: ['mod+shift+c'], label: '终端复制', category: '视图' },
  { id: 'view.terminalPaste', keys: ['mod+shift+v'], label: '终端粘贴', category: '视图' },
  { id: 'hud.snapToPointer', keys: ['mod+shift+g'], label: 'HUD 吸附指针', category: '视图' },
]

const STORAGE_KEY = 'mirach.desktop.keybinds'

/** 默认绑定表（actionId → combos）。 */
export function defaultBindings(): Record<string, string[]> {
  const table: Record<string, string[]> = {}
  for (const action of KEYBIND_ACTIONS) table[action.id] = [...action.defaults]
  return table
}

/** 读覆盖差分（损坏 JSON → {}；未知 id 丢弃——hermes 同语义）。 */
function readOverrides(): Record<string, string[]> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const known = new Set(KEYBIND_ACTIONS.map((a) => a.id))
    const out: Record<string, string[]> = {}
    for (const [id, combos] of Object.entries(parsed)) {
      if (!known.has(id)) continue
      if (!Array.isArray(combos)) continue
      const valid = combos.filter((c): c is string => typeof c === 'string')
      out[id] = valid
    }
    return out
  } catch (e) {
    console.error('[keybinds] 覆盖读取失败——按无覆盖处理', e)
    return {}
  }
}

function writeOverrides(overrides: Record<string, string[]>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides))
  } catch (e) {
    console.error('[keybinds] 覆盖写入失败', e)
    throw e
  }
}

/** 当前生效绑定（默认 + 覆盖合并）。 */
export function currentBindings(): Record<string, string[]> {
  const defaults = defaultBindings()
  const overrides = readOverrides()
  const merged: Record<string, string[]> = {}
  for (const action of KEYBIND_ACTIONS) {
    merged[action.id] = overrides[action.id] ?? defaults[action.id]
  }
  return merged
}

/** 指定 action 的当前组合。 */
export function bindingsFor(actionId: string): string[] {
  return currentBindings()[actionId] ?? []
}

/** 组合冲突检测：返回同样绑定了该组合的其它 action id。 */
export function conflictsFor(combo: string, excludeActionId: string): string[] {
  const bindings = currentBindings()
  const out: string[] = []
  for (const [id, combos] of Object.entries(bindings)) {
    if (id === excludeActionId) continue
    if (combos.includes(combo)) out.push(id)
  }
  return out
}

interface KeybindStore {
  /** 生效绑定（覆盖合并后的快照；写操作后重新派生）。 */
  bindings: Record<string, string[]>
  /** 捕获态：正在等待重绑的 action id（null = 无）。 */
  capturing: string | null
  refresh(): void
  beginCapture(actionId: string): void
  endCapture(): void
  setBinding(actionId: string, combos: string[]): void
  clearBinding(actionId: string): void
  resetBinding(actionId: string): void
  resetAllBindings(): void
}

export const useKeybindStore = create<KeybindStore>()((set) => ({
  bindings: currentBindings(),
  capturing: null,

  refresh: () => set({ bindings: currentBindings() }),
  beginCapture: (actionId) => set({ capturing: actionId }),
  endCapture: () => set({ capturing: null }),

  setBinding: (actionId, combos) => {
    const overrides = readOverrides()
    const defaults = defaultBindings()
    // 与默认一致 → 从覆盖表移除（存储契约：只存差分）
    if (arraysEqual(combos, defaults[actionId])) {
      delete overrides[actionId]
    } else {
      overrides[actionId] = combos
    }
    writeOverrides(overrides)
    set({ bindings: currentBindings(), capturing: null })
  },

  clearBinding: (actionId) => {
    const overrides = readOverrides()
    overrides[actionId] = []
    writeOverrides(overrides)
    set({ bindings: currentBindings(), capturing: null })
  },

  resetBinding: (actionId) => {
    const overrides = readOverrides()
    delete overrides[actionId]
    writeOverrides(overrides)
    set({ bindings: currentBindings(), capturing: null })
  },

  resetAllBindings: () => {
    writeOverrides({})
    set({ bindings: currentBindings(), capturing: null })
  },
}))

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** KeyboardEvent → canonical 组合串（hermes combo.ts 语义：`mod+<key>`，
 * `mod` = 主加速键；IME 组合中返回 null——不抢输入法）。 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (e.isComposing) return null
  const mod = e.ctrlKey || e.metaKey
  if (!mod) return null
  const key = e.key
  // 修饰键本体不成组合（捕获态要等真正的键）
  if (key === 'Control' || key === 'Meta' || key === 'Alt' || key === 'Shift') return null
  const base = key.toLowerCase()
  const parts = ['mod']
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  parts.push(base)
  return parts.join('+')
}

/** 组合串 → 展示文本（mod 显示为 Ctrl，`+` 分隔）。 */
export function formatCombo(combo: string): string {
  return combo
    .split('+')
    .map((part) => (part === 'mod' ? 'Ctrl' : part === 'escape' ? 'Esc' : part.toUpperCase()))
    .join('+')
}
