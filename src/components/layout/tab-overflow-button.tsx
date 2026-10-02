/**
 * 多页签条溢出下拉按钮（用户 2026-10-03 ZCode 参考）：tab 数 ≥ 2 时
 * 在 leading（"标签前面"）显示计数按钮 + DropdownMenu 列出**所有 tab**
 * ——点击跳转（SELECT_TAB_ACTIVE），右侧 ✕ 关闭（closePane，隐藏未激活
 * 走 hide-only 路径）。触发刷新：onRenderTabSet 在 flexlayout 模型变化
 * 时重建，React 子组件 remount → 直接读 model 最新 children，无需
 * 桥接 store。
 *
 * 数据面：tabsetId + 当前 model（flexlayout 不依赖 React——通过
 * window.__flModel 调试句柄读取；运行时 Layout 组件的 model prop 也
 * 暴露，可改用 prop，但 onRenderTabSet 不传子节点 model）。
 */
import { DropdownMenu } from 'radix-ui'
import { ChevronDownIcon, XIcon } from 'lucide-react'
import type { ReactElement } from 'react'
import { TabNode, TabSetNode, Actions } from 'flexlayout-react'
import { closePane } from './pane-registry'

interface TabMeta {
  id: string
  name: string
  active: boolean
  closeable: boolean
}

const readTabs = (tabsetId: string): TabMeta[] => {
  const m = (globalThis as unknown as { __flModel?: { getNodeById: (id: string) => unknown } }).__flModel
  if (!m) return []
  const ts = m.getNodeById(tabsetId)
  if (!(ts instanceof TabSetNode)) return []
  const selected = ts.getSelectedNode()?.getId()
  return ts.getChildren()
    .filter((c): c is TabNode => c instanceof TabNode)
    .map((c) => ({
      id: c.getId(),
      name: c.getName() ?? '(未命名)',
      active: selected === c.getId(),
      closeable: c.isEnableClose(),
    }))
}

const selectTab = (tabsetId: string, tabId: string): void => {
  const m = (globalThis as unknown as { __flModel?: { getNodeById: (id: string) => unknown; doAction: (a: unknown) => void } }).__flModel
  if (!m) return
  const idx = m.getNodeById(tabsetId) instanceof TabSetNode
    ? (m.getNodeById(tabsetId) as TabSetNode).getChildren().findIndex((c) => c.getId() === tabId)
    : -1
  if (idx < 0) return
  // Actions.SELECT_TAB 接受 { tabNode: id }（factory：selectTab(tabNodeId)）
  m.doAction(Actions.selectTab(tabId))
}

const onClose = (m: ReturnType<typeof readTabs> extends never ? never : {
  doAction: (a: unknown) => void
  getNodeById: (id: string) => unknown
}, tabId: string): void => {
  // 走 closePane 同语义（hide-only：会话等 reopenable=true 的关掉但保留配置；
  // 一级窗格回家）——与 ✕ 钮同源。closePane 不依赖 React，传 model。
  const node = m.getNodeById(tabId)
  // closePane 接受 Model 对象；cast unknown 调
  void closePane(m as unknown as Parameters<typeof closePane>[0], tabId)
}

export function TabOverflowButton({ tabsetId }: { tabsetId: string }): ReactElement | null {
  const tabs = readTabs(tabsetId)
  if (tabs.length < 2) return null
  const m = (globalThis as unknown as { __flModel?: { doAction: (a: unknown) => void; getNodeById: (id: string) => unknown } }).__flModel
  if (!m) return null
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          aria-label="显示所有标签"
          className="tab-overflow-btn"
          onPointerDown={(e) => e.stopPropagation()}
          type="button"
        >
          <ChevronDownIcon size={12} />
          <span>{tabs.length}</span>
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          className="tab-overflow-menu"
          collisionPadding={8}
          side="bottom"
          sideOffset={4}
        >
          {tabs.map((t) => (
            <DropdownMenu.Item
              className={`tab-overflow-item${t.active ? ' active' : ''}`}
              key={t.id}
              onSelect={(e) => {
                // 单击项 = 跳转激活（radix 默认 select 关闭菜单）
                e.preventDefault?.()
                selectTab(tabsetId, t.id)
              }}
            >
              <span className="label">{t.name}</span>
              {t.closeable && (
                <button
                  aria-label={`关闭 ${t.name}`}
                  className="close-btn"
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    onClose(m, t.id)
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  type="button"
                >
                  <XIcon size={10} />
                </button>
              )}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  )
}