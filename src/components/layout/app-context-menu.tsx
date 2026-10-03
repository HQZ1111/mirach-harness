/**
 * THE app context menu——hermes app/context-menu/app-context-menu.tsx（719 行）
 * 的整抄移植，Tauri 语义裁剪逐处注释。
 *
 * hermes 架构（源文件头注释）：全应用一个右键体系 = 一份 capture 监听 +
 * 一个 $contextMenu store + 一份菜单；行/树等 Radix 自管面保留自己的菜单，
 * 其余一切按点击落点组装，空落点回退 shellSections（bare right-click on
 * app chrome = 窗口动词，即用户截图那份菜单）。
 *
 * harness 分工（与 hermes 的结构差异，仅一处）：capture 监听与三面裁定
 * （editable 原生 / owned 行树 Radix / pane 窗格菜单）留在 main.tsx——
 * 工程已有该层（context-menu-scope.ts，单测在案）；本文件持有 store +
 * 一份菜单 + 动作。scope='app' 分支按落点分派：.flexlayout__tabset 内
 * （页签 body 之外）→ pane-context-menu 的 ZoneMenu（openZoneContextMenuAt，
 * hermes 的 strip 面）；其余落点调 openAppContextMenu(x,y)，本组件
 * 消费 store 渲染菜单（cursor 位置、受控 DropdownMenu 形态照抄 hermes：
 * 点击点上的零尺寸 fixed 锚 span + open 常开 + onOpenChange(false) 关闭）。
 * 「切换标签」按 hermes toggleTargetZoneTabStrip 作用于单一目标分栏（资格
 * 阶梯见 toggleTargetTabStrip）。
 *
 * hermes domSections/guestSections/terminalSections 三段在本工程的裁剪：
 * - guest 段：无 webview guest（预览 webview 未建）——整段不适用；
 * - terminal 段：终端右键走 .flexlayout__tab 窗格菜单（pane scope），
 *   无 xterm handle 注册面；
 * - dom 段的 editable 分支：editable 已由 scope 放行 WebView2 原生编辑
 *   菜单（工程裁定：harness 无 Electron editFlags/桥接编辑命令，原生菜单
 *   就是正确的编辑面）——app 层的 editable 段不重复；link/image/selection
 *   分支依赖 Electron 桥（openPreview/openExternalLink/contextMenuEdit/
 *   saveImageFromUrl/writeClipboardText），Tauri 无对应桥面 → 裁掉。dom
 *   段整段为空时 hermes 回退 shellSections（app-context-menu.tsx:686
 *   `list.length ? list : shellSections(...)`）——本工程 scope='app' 恒为
 *   空落点，shell 菜单即唯一段。
 *
 * shellSections 项裁剪（项序/图标/文案/i18n 键名照抄 hermes zh catalog，
 * harness 无 i18n 运行时 → 文案字面量旁注 hermes 键，thread-list/pane
 * 菜单同款约定）：
 * - 新建窗口（shell-new-window，icon multiple-windows）：hermes 条件行
 *   （canOpenNewWindow() 条件渲染 + null filter）。Tauri 技术上可开
 *   WebviewWindow，但本工程是单窗格架构（main.tsx ?win= 是窗口分派不是
 *   多窗格）→ 按 hermes 条件渲染语义裁掉：条件恒不满足 = 整行缺席。
 *   L5 多窗格落地再启。
 * - 切换配置档案栏（shell-profile-rail，icon organization）：无 profile
 *   rail（hermes toggleProfileRailVisible 无对应物）→ 裁掉。
 * - 更新 Hermes（shell-update，icon cloud-download）：Electron updater
 *   的 requestActiveUpdate 无对应物（Tauri 无 updater 配置）→ 裁掉；
 *   第三段整段为空 → 不渲染该段与其分隔线。
 */
import { Actions, TabNode, TabSetNode, type Model } from 'flexlayout-react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import { useEffect, useState, type FC } from 'react'
import { createPortal } from 'react-dom'
import { createStore, useStore } from 'zustand'

import { SettingsOverlay } from '@/app/overlays/settings-overlay'
import { toggleStatusbarVisible } from '@/app/shell/statusbar'
import { CommandPalette, type PaletteCommand } from '@/components/assistant-ui/elements/command-palette'

import { zoneTabsetFromDom } from './pane-context-menu'
import { zoneConfigOf } from './pane-registry'
import { sessionCatalog } from '@/components/panes/session-manage/session-catalog'

// ── store（hermes store.ts 的 $contextMenu 同构：单份菜单，两个菜单永不
//    同开；harness 的 open 载荷只剩坐标——dom/guest/terminal 三 kind 已裁，
//    见文件头） ─────────────────────────────────────────────────────────────

interface AppContextMenuState {
  /** 打开中的菜单锚点（viewport 坐标），null = 无菜单。 */
  open: { x: number; y: number } | null
  openAt(x: number, y: number): void
  close(): void
}

export const appContextMenuStore = createStore<AppContextMenuState>((set) => ({
  open: null,
  openAt: (x, y) => set({ open: { x, y } }),
  close: () => set({ open: null }),
}))

/** main.tsx scope='app' 分支的入口（hermes openDomContextMenu 的 shell
 *  等价物：hermes 空落点走 openDomContextMenu + dom 段空回退 shell 段，
 *  本工程段在打开前即已确定）。 */
export function openAppContextMenu(x: number, y: number): void {
  appContextMenuStore.getState().openAt(x, y)
}

function closeAppContextMenu(): void {
  appContextMenuStore.getState().close()
}

// ── codicon 字形（hermes Codicon 组件的 harness 对应位：@vscode/codicons
//    SVG path 内联——harness 没有 codicon 字体，codicons.tsx 同款约定。
//    路径逐字取上游 src/icons/*.svg；settings-gear 上游即 24 viewBox） ────

export const CODICON_GLYPHS: Record<string, { viewBox: string; d: readonly string[] }> = {
  add: {
    viewBox: '0 0 16 16',
    d: [
      'M8 1.5C8 1.22386 7.77614 1 7.5 1C7.22386 1 7 1.22386 7 1.5V7H1.5C1.22386 7 1 7.22386 1 7.5C1 7.77614 1.22386 8 1.5 8H7V13.5C7 13.7761 7.22386 14 7.5 14C7.77614 14 8 13.7761 8 13.5V8H13.5C13.7761 8 14 7.77614 14 7.5C14 7.22386 13.7761 7 13.5 7H8V1.5Z',
    ],
  },
  search: {
    viewBox: '0 0 16 16',
    d: [
      'M10.0195 10.7266C9.06578 11.5217 7.83875 12 6.5 12C3.46243 12 1 9.53757 1 6.5C1 3.46243 3.46243 1 6.5 1C9.53757 1 12 3.46243 12 6.5C12 7.83875 11.5217 9.06578 10.7266 10.0195L13.8535 13.1464C14.0488 13.3417 14.0488 13.6583 13.8535 13.8536C13.6583 14.0488 13.3417 14.0488 13.1464 13.8536L10.0195 10.7266ZM11 6.5C11 4.01472 8.98528 2 6.5 2C4.01472 2 2 4.01472 2 6.5C2 8.98528 4.01472 11 6.5 11C8.98528 11 11 8.98528 11 6.5Z',
    ],
  },
  'layout-statusbar': {
    viewBox: '0 0 16 16',
    d: [
      'M1 3.5V12.5C1 13.881 2.119 15 3.5 15H12.5C13.881 15 15 13.881 15 12.5V3.5C15 2.119 13.881 1 12.5 1H3.5C2.119 1 1 2.119 1 3.5ZM14 12H2V3.5C2 2.672 2.672 2 3.5 2H12.5C13.328 2 14 2.672 14 3.5V12Z',
    ],
  },
  'layout-menubar': {
    viewBox: '0 0 16 16',
    d: [
      'M4.5 3C4.776 3 5 3.224 5 3.5C5 3.776 4.776 4 4.5 4H3.5C3.224 4 3 3.776 3 3.5C3 3.224 3.224 3 3.5 3H4.5Z',
      'M7.5 3C7.776 3 8 3.224 8 3.5C8 3.776 7.776 4 7.5 4H6.5C6.224 4 6 3.776 6 3.5C6 3.224 6.224 3 6.5 3H7.5Z',
      'M10.5 3C10.776 3 11 3.224 11 3.5C11 3.776 10.776 4 10.5 4H9.5C9.224 4 9 3.776 9 3.5C9 3.224 9.224 3 9.5 3H10.5Z',
      'M12.5 1C13.881 1 15 2.119 15 3.5V12.5C15 13.881 13.881 15 12.5 15H3.5C2.119 15 1 13.881 1 12.5V3.5C1 2.119 2.119 1 3.5 1H12.5ZM3.5 2C2.672 2 2 2.672 2 3.5V12.5C2 13.328 2.672 14 3.5 14H12.5C13.328 14 14 13.328 14 12.5V3.5C14 2.672 13.328 2 12.5 2H3.5Z',
    ],
  },
  'settings-gear': {
    viewBox: '0 0 24 24',
    d: [
      'M12 9C10.3425 9 9.00002 10.3425 9.00002 12C9.00002 13.6575 10.3425 15 12 15C13.6575 15 15 13.6575 15 12C15 10.3425 13.6575 9 12 9ZM12 13.5C11.172 13.5 10.5 12.828 10.5 12C10.5 11.172 11.172 10.5 12 10.5C12.828 10.5 13.5 11.172 13.5 12C13.5 12.828 12.828 13.5 12 13.5ZM21.8475 14.5725L19.9185 12.942C19.8675 12.8985 19.8195 12.8505 19.776 12.7995C19.332 12.279 19.3965 11.5005 19.9185 11.058L21.8475 9.4275C22.0395 9.2655 22.113 9.0045 22.0365 8.766C21.579 7.3545 20.823 6.06 19.8285 4.962C19.7085 4.83 19.5405 4.758 19.368 4.758C19.2975 4.758 19.227 4.77 19.1595 4.794L16.779 5.6415C16.716 5.664 16.65 5.682 16.584 5.694C16.509 5.7075 16.434 5.715 16.3605 5.715C15.7725 5.715 15.2505 5.298 15.141 4.701L14.6865 2.223C14.6415 1.977 14.451 1.782 14.205 1.7295C13.485 1.5765 12.7485 1.5 12.0015 1.5C11.2545 1.5 10.5165 1.578 9.79652 1.7295C9.55052 1.782 9.36002 1.977 9.31502 2.223L8.86202 4.701C8.85002 4.767 8.83202 4.8315 8.80952 4.8945C8.62802 5.4 8.15102 5.715 7.64102 5.715C7.50302 5.715 7.36202 5.691 7.22402 5.643L4.84352 4.7955C4.77602 4.7715 4.70402 4.7595 4.63502 4.7595C4.46252 4.7595 4.29452 4.8315 4.17452 4.9635C3.17852 6.0615 2.42402 7.356 1.96502 8.7675C1.88702 9.006 1.96202 9.267 2.15402 9.429L4.08302 11.0595C4.13402 11.103 4.18202 11.151 4.22552 11.202C4.66952 11.7225 4.60502 12.501 4.08302 12.9435L2.15402 14.574C1.96202 14.736 1.88852 14.997 1.96502 15.2355C2.42252 16.647 3.17852 17.9415 4.17452 19.0395C4.29452 19.1715 4.46252 19.2435 4.63502 19.2435C4.70552 19.2435 4.77602 19.2315 4.84352 19.2075L7.22402 18.36C7.28702 18.3375 7.35302 18.3195 7.41902 18.3075C7.49402 18.294 7.56902 18.288 7.64252 18.288C8.23052 18.288 8.75252 18.705 8.86202 19.302L9.31502 21.78C9.36002 22.026 9.55052 22.221 9.79652 22.2735C10.5165 22.4265 11.2545 22.503 12.0015 22.503C12.7485 22.503 13.4865 22.425 14.205 22.2735C14.451 22.221 14.6415 22.026 14.6865 21.78L15.141 19.302C15.153 19.236 15.171 19.1715 15.1935 19.1085C15.375 18.603 15.852 18.288 16.362 18.288C16.5 18.288 16.641 18.312 16.779 18.36L19.158 19.2075C19.227 19.2315 19.2975 19.2435 19.3665 19.2435C19.539 19.2435 19.707 19.1715 19.827 19.0395C20.823 17.9415 21.5775 16.647 22.035 15.2355C22.113 14.997 22.038 14.736 21.846 14.574L21.8475 14.5725ZM19.092 17.589L17.2815 16.944C16.9845 16.839 16.6755 16.785 16.362 16.785C15.2085 16.785 14.1705 17.514 13.782 18.5985C13.731 18.738 13.6935 18.882 13.6665 19.029L13.3215 20.9055C12.8865 20.9685 12.444 21 12.0015 21C11.559 21 11.1165 20.9685 10.68 20.904L10.3365 19.0275C10.098 17.727 8.96552 16.7835 7.64252 16.7835C7.48052 16.7835 7.31552 16.7985 7.14902 16.8285C7.00352 16.8555 6.86102 16.893 6.72002 16.9425L4.90952 17.5875C4.35752 16.896 3.91652 16.1385 3.59102 15.321L5.05202 14.0865C5.61152 13.614 5.95202 12.951 6.01202 12.222C6.07202 11.493 5.84252 10.785 5.36702 10.227C5.27102 10.1145 5.16452 10.008 5.05202 9.912L3.59102 8.6775C3.91652 7.86 4.35752 7.101 4.90952 6.411L6.72002 7.056C7.01702 7.161 7.32602 7.215 7.64102 7.215C8.79452 7.215 9.83252 6.486 10.221 5.4015C10.272 5.2605 10.3095 5.1165 10.3365 4.971L10.68 3.0945C11.1165 3.0315 11.559 2.9985 12.0015 2.9985C12.444 2.9985 12.8865 3.03 13.3215 3.093L13.665 4.9695C13.9035 6.27 15.036 7.2135 16.359 7.2135C16.521 7.2135 16.686 7.1985 16.851 7.1685C16.9965 7.1415 17.1405 7.104 17.2815 7.0545L19.092 6.4095C19.644 7.0995 20.085 7.8585 20.4105 8.676L18.951 9.9105C18.3915 10.383 18.0495 11.046 17.991 11.775C17.931 12.504 18.1605 13.2135 18.636 13.77C18.7335 13.884 18.8385 13.989 18.9525 14.085L20.4135 15.3195C20.088 16.137 19.647 16.896 19.095 17.586L19.092 17.589Z',
    ],
  },
}

const CodiconGlyph: FC<{ className?: string; name: string }> = ({ className, name }) => {
  const glyph = CODICON_GLYPHS[name]
  if (!glyph) {
    console.error('[app-context-menu] 未知 codicon 字形', name)
    return null
  }
  return (
    <svg aria-hidden className={className} fill="currentColor" viewBox={glyph.viewBox}>
      {glyph.d.map((d, i) => (
        <path d={d} key={i} />
      ))}
    </svg>
  )
}

// ── 菜单项清单（hermes shellSections 的纯投影：node 可测） ────────────────

export interface AppMenuItemSpec {
  id: string
  icon: string
  /** hermes zh catalog 逐字（键名见各行注释）。 */
  label: string
}

export type AppMenuSection = readonly AppMenuItemSpec[]

/**
 * bare right-click on app chrome 的段结构 = hermes shellSections
 * （app-context-menu.tsx:551-608）裁剪后：
 *   段1 [新建会话, （新建窗口已裁）, 命令面板]
 *   段2 [切换状态栏, （切换配置档案栏已裁）, 切换标签, 设置]
 *   段3 [更新 Hermes——已裁，整段消失]
 */
export const buildShellMenuSections = (): readonly AppMenuSection[] => [
  [
    {
      // t.commandCenter.nav.newChat.title → hermes navigateToWorkspacePage(
      // NEW_CHAT_ROUTE)；harness 无路由，走既有新建通道（runShellAction）
      icon: 'add',
      id: 'shell-new-chat',
      label: '新建会话',
    },
    {
      // t.commandCenter.paletteTitle → hermes openCommandPalette
      icon: 'search',
      id: 'shell-palette',
      label: '命令面板',
    },
  ],
  [
    {
      // t.keybinds.actions['view.toggleStatusbar'] → hermes
      // toggleStatusbarVisible（store/statusbar-prefs）
      icon: 'layout-statusbar',
      id: 'shell-statusbar',
      label: '切换状态栏',
    },
    {
      // t.keybinds.actions['view.toggleTabStrip'] → hermes
      // toggleTargetZoneTabStrip（"the pointer-only way back to a hidden
      // tab strip"）。hermes 作用于单一目标 zone；本工程同构：右键点所在
      // 分栏（资格阶梯见 toggleTargetTabStrip——点→活动分栏→主区分栏），
      // runShellAction('shell-tabstrip')
      icon: 'layout-menubar',
      id: 'shell-tabstrip',
      label: '切换标签',
    },
    {
      // t.commandCenter.settings → hermes navigateToWorkspacePage(
      // SETTINGS_ROUTE)；harness 等价面 = 设置浮层 SettingsOverlay（最小
      // 开关挂载，见 SettingsHost）
      icon: 'settings-gear',
      id: 'shell-settings',
      label: '设置',
    },
  ],
]

// ── 「切换标签」的纯规划（hermes toggleTargetZoneTabStrip 同构：作用于
//    **右键点所在的单一目标分栏**，非全窗格——hermes tabTargetGroup 资格
//    阶梯 hovered→active→main 的落点在 resolveStripTarget）。"Toggle
//    against what is ON SCREEN"——目标可见 → 隐藏；不可见 → 显示（strip
//    已隐藏的分栏，这是指针唯一的找回途径）。轨（20px 导航轨，
//    zoneConfigOf.track）与竖轨形态大栏（该栏存在轨；其分栏标签条由竖轨
//    模式统管——constraints-sync wantStrip=!rail / 窗格菜单 stripLocked
//    同语义）不在切换面。 ─────────────────────────────────────────────────

export interface TabStripSetSnapshot {
  id: string
  stripVisible: boolean
  track: boolean
  region?: string
}

export interface TabStripPatch {
  id: string
  enableTabStrip: boolean
}

export const planTabStripToggle = (
  targetId: string,
  sets: readonly TabStripSetSnapshot[],
): readonly TabStripPatch[] => {
  const target = sets.find((s) => s.id === targetId)
  if (!target || target.track) return []
  const railRegions = new Set(sets.filter((s) => s.track && s.region).map((s) => s.region as string))
  if (target.region !== undefined && railRegions.has(target.region)) return []
  return [{ id: target.id, enableTabStrip: !target.stripVisible }]
}

/** 活动布局模型（flex-layout.tsx 的调试句柄，模型替换/卸载时随 React
 *  effect 同步维护）。菜单在树外挂载拿不到 React 持有的 Model——这是
 *  布局面之外的唯一既有通道；不在场 = 错误可见（禁止兜底）。 */
const activeLayoutModel = (): Model | undefined => {
  const model = (window as { __flModel?: Model }).__flModel
  if (!model) {
    console.error('[app-context-menu] 活动布局模型不在场（__flModel 未挂载）')
  }
  return model
}

// ── 动作（runShellAction：菜单 id → 既有通道） ─────────────────────────────

/** 新建会话：走既有新建通道——段头「新建会话」钮（thread-list.aui.tsx
 *  ThreadListNewAria → ThreadListPrimitive.New → runtime threadListAdapter
 *  onSwitchToNewThread → pi_discard_session）。useAui 仅 React 树内可用，
 *  本菜单在树外挂载 → 触发同一 DOM 通道（点按语义一致，runtime 是唯一
 *  能动 pi 会话 handle 的层）。通道不在场（会话窗格未挂载）= 错误可见。 */
const triggerNewChat = (): void => {
  const trigger = document.querySelector<HTMLButtonElement>('button[aria-label="新建会话"]')
  if (!trigger) {
    console.error('[app-context-menu] 新建会话通道不在场（段头新建钮未挂载）')
    return
  }
  trigger.click()
}

/** 切换标签：作用于右键点所在分栏（hermes toggleTargetZoneTabStrip——
 *  "the pointer-only way back to a hidden tab strip: right-clicking the
 *  shell reaches this menu from anywhere, including a zone that has no
 *  chrome left"）。目标分栏按 hermes tabTargetGroup 资格阶梯定位：
 *  ①右键点所在 tabset（elementsFromPoint 沿命中栈找——app 菜单锚在右键点，
 *  菜单面会盖住该点，栈里越过菜单层找页面落点）；②活动分栏
 *  （getActiveTabset，hermes $activeTreeGroup）；③主区所在分栏（hermes
 *  findGroupOfPane(tree,'workspace')）。快照在点击时刻现读（hermes "Toggle
 *  against what is ON SCREEN"）；updateNodeAttributes 随模型 JSON 持久化
 *  ——下一次结构动作的 syncTabsetConstraints 会按 region 规则重铸，与
 *  窗格菜单的隐藏/显示标签同一生命周期。无目标 / 目标在切换面外（轨/
 *  竖轨形态）= 错误可见（规矩 12）。 */
const snapshotTabStripSets = (model: Model): TabStripSetSnapshot[] => {
  const sets: TabStripSetSnapshot[] = []
  model.visitNodes((node) => {
    if (!(node instanceof TabSetNode)) return
    const cfg = zoneConfigOf(node)
    sets.push({
      id: node.getId(),
      stripVisible: node.isEnableTabStrip(),
      track: cfg?.track === true,
      region: cfg?.region,
    })
  })
  return sets
}

const stripTargetFromPoint = (x: number, y: number): TabSetNode | undefined => {
  for (const el of document.elementsFromPoint(x, y)) {
    const setEl = el instanceof Element ? el.closest('.flexlayout__tabset') : null
    if (!setEl) continue
    const set = zoneTabsetFromDom(setEl)
    // 停车轨不在切换面（与 planTabStripToggle 的 track 排除同语义），继续
    // 沿命中栈找页面落点。
    if (set && !zoneConfigOf(set)?.track) return set
  }
  return undefined
}

/** 资格阶梯回退梯级（hermes tabTargetGroup：active → workspace 主区）。
 *  右键点在分栏外（标题栏/状态栏/分隔条——app 菜单的常驻开面）时 hover 梯
 *  级必空，落到这两级。纯模型运算（node 单测在案）。 */
export const stripTargetFallback = (model: Model): TabSetNode | undefined => {
  const active = model.getActiveTabset()
  if (active) return active
  const ws = model.getNodeById('workspace')
  if (ws instanceof TabNode) {
    const parent = ws.getParent()
    if (parent instanceof TabSetNode) return parent
  }
  return undefined
}

const toggleTargetTabStrip = (): void => {
  const model = activeLayoutModel()
  if (!model) return
  const point = appContextMenuStore.getState().open
  const target = (point ? stripTargetFromPoint(point.x, point.y) : undefined) ?? stripTargetFallback(model)
  if (!target) {
    console.error('[app-context-menu] 切换标签：无可定位的目标分栏')
    return
  }
  const patches = planTabStripToggle(target.getId(), snapshotTabStripSets(model))
  if (patches.length === 0) {
    console.error('[app-context-menu] 切换标签：目标分栏不在切换面（轨/竖轨形态）', target.getId())
    return
  }
  // hermes toggleTargetZoneTabStrip 语义：对**屏幕现状**取反，写入显式
  // mode（zone 离开 auto，不随页签数漂移）；mode 存 tabset config（随布局
  // JSON 持久化），**条的实际显隐由 sync 的阶梯 resolver 从 mode+内容推导**。
  for (const patch of patches) {
    const next = patch.enableTabStrip ? 'always' : 'never'
    model.doAction(
      Actions.updateNodeAttributes(patch.id, {
        enableTabStrip: patch.enableTabStrip,
        config: { ...zoneConfigOf(model.getNodeById(patch.id) as TabSetNode), tabStripMode: next },
      }),
    )
  }
}

export const runShellAction = (id: string): void => {
  switch (id) {
    case 'shell-new-chat':
      triggerNewChat()
      return
    case 'shell-palette':
      openCommandPalette()
      return
    case 'shell-statusbar':
      toggleStatusbarVisible()
      return
    case 'shell-tabstrip':
      toggleTargetTabStrip()
      return
    case 'shell-settings':
      openSettingsOverlay()
      return
    default:
      console.error('[app-context-menu] unknown menu item', id)
  }
}

// ── 命令面板最小开关（hermes store/command-palette.ts openCommandPalette
//    的等价物）：官方模板 elements/command-palette.tsx 是受控纯投影
//    （props 喂 commands/query/activeId），此前无 consume——本菜单项触发
//    它挂载显示。命令清单 = 本菜单动作的真实动作面（不造数据；keys 空
//    ——工程无键位层，不虚构快捷键）。 ─────────────────────────────────────

interface AppPaletteState {
  open: boolean
  openPalette(): void
  closePalette(): void
}

export const appPaletteStore = createStore<AppPaletteState>((set) => ({
  open: false,
  openPalette: () => set({ open: true }),
  closePalette: () => set({ open: false }),
}))

export function openCommandPalette(): void {
  appPaletteStore.getState().openPalette()
}

/** 命令清单：id 与菜单动作同源（runShellAction 直接执行），文案逐字同菜单。 */
export const PALETTE_COMMANDS: readonly PaletteCommand[] = [
  { id: 'shell-new-chat', label: '新建会话', group: '命令', keys: [] },
  { id: 'shell-statusbar', label: '切换状态栏', group: '命令', keys: [] },
  { id: 'shell-tabstrip', label: '切换标签', group: '命令', keys: [] },
  { id: 'shell-settings', label: '设置', group: '命令', keys: [] },
]

const CommandPaletteHost: FC = () => {
  const open = useStore(appPaletteStore, (s) => s.open)
  const [query, setQuery] = useState('')
  const [activeId, setActiveId] = useState(PALETTE_COMMANDS[0].id)

  // 打开即复位查询/高亮，并聚焦输入框（模板 input 无 ref/autofocus——
  // 面板挂载完成后的下一帧聚焦，Scoped 到本 portal 实例）。
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveId(PALETTE_COMMANDS[0].id)
    const raf = requestAnimationFrame(() => {
      document.querySelector<HTMLInputElement>('[data-slot="command-palette"] input')?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [open])

  if (!open) return null

  // query 过滤口径与模板内部一致（label 子串）；高亮被过滤掉时钳回首条
  // 匹配——Enter 只在模板内部 ordered 里找 active，找不到就不跑。
  const handleQueryChange = (q: string) => {
    setQuery(q)
    const needle = q.toLowerCase()
    const matches = PALETTE_COMMANDS.filter((c) => c.label.toLowerCase().includes(needle))
    if (!matches.some((c) => c.id === activeId)) {
      setActiveId(matches[0]?.id ?? PALETTE_COMMANDS[0].id)
    }
  }

  const handleRun = (id: string) => {
    appPaletteStore.getState().closePalette()
    runShellAction(id)
  }

  return createPortal(
    <div
      className="fixed inset-0 flex items-start justify-center bg-(--overlay-mask) pt-[14vh] [z-index:var(--z-modal-backdrop)]"
      onKeyDown={(e) => {
        if (e.key === 'Escape') appPaletteStore.getState().closePalette()
      }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) appPaletteStore.getState().closePalette()
      }}
    >
      <CommandPalette
        activeId={activeId}
        commands={PALETTE_COMMANDS}
        onActiveChange={setActiveId}
        onQueryChange={handleQueryChange}
        onRun={handleRun}
        query={query}
      />
    </div>,
    document.body,
  )
}

// ── 设置浮层最小开关（hermes SETTINGS_ROUTE 导航的等价物：设置浮层
//    settings-overlay.tsx 已落位但无挂载开关——本菜单项触发挂载显示，
//    关闭走浮层自己的 onClose） ────────────────────────────────────────────

interface AppSettingsState {
  open: boolean
  openSettings(): void
  closeSettings(): void
}

export const appSettingsStore = createStore<AppSettingsState>((set) => ({
  open: false,
  openSettings: () => set({ open: true }),
  closeSettings: () => set({ open: false }),
}))

export function openSettingsOverlay(): void {
  appSettingsStore.getState().openSettings()
}

const SettingsHost: FC = () => {
  const open = useStore(appSettingsStore, (s) => s.open)
  if (!open) return null
  return <SettingsOverlay onClose={() => appSettingsStore.getState().closeSettings()} />
}

// ── 菜单渲染（hermes AppContextMenu 组件逐形制：受控 DropdownMenu +
//    零尺寸锚点 + 段间分隔线） ─────────────────────────────────────────────

// 视觉 = 工程现役菜单族（thread-list.aui.tsx VIEW_MENU_* / pane-context-menu
// MENU_* 同令牌）：w-56 是 hermes app 菜单的内容宽（app-context-menu.tsx:704）。
const APP_MENU_CONTENT_CLASS =
  'bg-popover text-popover-foreground z-50 w-56 overflow-hidden rounded-xl border p-1.5 shadow-(--shadow-pop)'
const APP_MENU_ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-(--hover-wash)'
const APP_MENU_SEPARATOR_CLASS = 'bg-(--stroke-soft) mx-1 my-1 h-px'
const APP_MENU_ICON_CLASS = 'text-(--text-3) size-3.5 shrink-0'

export function AppContextMenu() {
  const open = useStore(appContextMenuStore, (s) => s.open)

  return (
    <>
      {open && (
        <DropdownMenuPrimitive.Root
          onOpenChange={(openState) => {
            if (!openState) {
              closeAppContextMenu()
            }
          }}
          open
        >
          <DropdownMenuPrimitive.Trigger asChild>
            {/* hermes 同款：点击点上的零尺寸锚点——菜单像真 Trigger 一样对它定位 */}
            <span aria-hidden style={{ left: open.x, position: 'fixed', top: open.y }} />
          </DropdownMenuPrimitive.Trigger>
          <DropdownMenuPrimitive.Portal>
            <DropdownMenuPrimitive.Content
              align="start"
              className={APP_MENU_CONTENT_CLASS}
              onCloseAutoFocus={(event) => event.preventDefault()}
              side="bottom"
            >
              {buildShellMenuSections().map((section, index) => (
                // 段按位置构造，index 即 key（hermes 同款注释）
                <div className="contents" key={index}>
                  {index > 0 && <DropdownMenuPrimitive.Separator className={APP_MENU_SEPARATOR_CLASS} />}
                  {section.map((item) => (
                    <DropdownMenuPrimitive.Item
                      className={APP_MENU_ITEM_CLASS}
                      key={item.id}
                      onSelect={() => runShellAction(item.id)}
                    >
                      <CodiconGlyph className={APP_MENU_ICON_CLASS} name={item.icon} />
                      <span>{item.label}</span>
                    </DropdownMenuPrimitive.Item>
                  ))}
                </div>
              ))}
            </DropdownMenuPrimitive.Content>
          </DropdownMenuPrimitive.Portal>
        </DropdownMenuPrimitive.Root>
      )}
      <CommandPaletteHost />
      <SettingsHost />
    </>
  )
}
