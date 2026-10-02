/**
 * 状态栏（用户定稿：高度 20）。当前是骨架占位 pill——网关/模型态接 pi 后
 * 由真实数据驱动（hermes app/shell/statusbar* 的 harness 对应位）。
 *
 * 整条可见性（hermes store/statusbar-prefs.ts 的 $statusbarVisible +
 * toggleStatusbarVisible 对应位，VS Code workbench.statusBar.visible 语义：
 * 隐藏 = 整条卸载，回程只能是 app 右键菜单的「切换状态栏」，同 hermes
 * 「the way back is the view.toggleStatusbar keybind, never the bar
 * itself」）。持久化 mirach.harness.statusbar.v1（工程命名），值
 * 'true'/'false'——sidebar-view parseShowArchived 同款严格解析：缺失 =
 * 默认可见，非法形状 console.error 回默认不冒充旧数据。
 */
import { createStore, useStore } from 'zustand'

export const STATUSBAR_VISIBLE_KEY = 'mirach.harness.statusbar.v1'

/** 严格解析（node 可测）：缺失/合法值之外的形状可见报错并回默认。 */
export const parseStatusbarVisible = (raw: string | null): boolean => {
  if (raw === null) return true
  if (raw === 'true') return true
  if (raw === 'false') return false
  console.error(`[statusbar] ${STATUSBAR_VISIBLE_KEY} 形状非法（应为 true|false）——回默认`, raw)
  return true
}

const readStoredVisible = (): boolean => {
  if (typeof localStorage === 'undefined') return true
  try {
    return parseStatusbarVisible(localStorage.getItem(STATUSBAR_VISIBLE_KEY))
  } catch (e) {
    console.error('[statusbar] localStorage 读取失败——回默认可见', e)
    return true
  }
}

interface StatusbarPrefsState {
  visible: boolean
  toggle(): void
}

export const statusbarPrefs = createStore<StatusbarPrefsState>((set, get) => ({
  visible: readStoredVisible(),
  toggle: () => {
    const next = !get().visible
    set({ visible: next })
    try {
      localStorage.setItem(STATUSBAR_VISIBLE_KEY, next ? 'true' : 'false')
    } catch (e) {
      console.error('[statusbar] localStorage 写入失败——可见性不持久', e)
    }
  },
}))

/** app 右键菜单的动作入口（hermes toggleStatusbarVisible 同名同语义）。 */
export const toggleStatusbarVisible = (): void => statusbarPrefs.getState().toggle()

export function StatusBar() {
  const visible = useStore(statusbarPrefs, (s) => s.visible)
  if (!visible) return null
  return (
    <div className="app-statusbar">
      <span className="statusbar-pill">default ▾</span>
      <span className="statusbar-pill">⏳ 网关 检查中</span>
      <span className="statusbar-spacer" />
      <span className="statusbar-pill">⚡ 智能</span>
    </div>
  )
}
