/**
 * 面板可见性（hermes `components/pane-shell/pane-visibility.ts` 的宿主对偶）。
 *
 * 上游用 pane-shell 的面板树判定可见性。宿主是 dockview，等价判据是
 * 「该 panel id 的 DOM 是否存在」。
 */
import { atom } from 'nanostores'

/**
 * React 侧的 keep-alive 可见性 API（`usePaneVisible` / `PaneVisibleContext` /
 * `queryAllVisible` …）：hermes-mirror 的 GlyphSpinner、cron 侧栏直接按上游
 * 路径 import 这些符号。宿主没有 pane-shell 树，镜像副本里的实现默认
 * "可见"（Context 默认 true、hidden 属性不存在），语义是安全的等价。
 *
 * 2026-11-16：此前只保留了 `$paneVisible`/`isPaneVisible`，缺 `usePaneVisible`
 * 让 vite 报 "does not provide an export named 'usePaneVisible'" → 整页白屏。
 */
export {
  PANE_HIDDEN_ATTR,
  hiddenPaneProps,
  PaneVisibleContext,
  usePaneVisible,
  PaneLifecycleContext,
  usePaneLifecycle,
  NO_PANE_GROUP,
  PaneGroupContext,
  usePaneGroup,
  isElementInHiddenPane,
  queryAllVisible,
  queryVisible,
} from '@/hermes-mirror/components/pane-shell/pane-visibility'

/** 某 panel 是否可见（响应式）。 */
export function $paneVisible(paneId: string) {
  return atom(typeof document !== 'undefined' && Boolean(document.querySelector(`[data-panel-id="${paneId}"]`)))
}

/** 命令式判定。 */
export function isPaneVisible(paneId: string): boolean {
  return typeof document !== 'undefined' && Boolean(document.querySelector(`[data-panel-id="${paneId}"]`))
}

