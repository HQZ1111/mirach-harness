/**
 * 审查面板 —— hermes 桌面端 `app/right-sidebar/review/index.tsx`（243 行）
 * 的移植。
 *
 * 结构（逐块对照上游）：
 *  头部：自命名标签 + 树/列表切换 + 全部暂存 + 全部还原 + 刷新 + 关闭
 *  scope 行（未提交 / 分支 / 上一轮）
 *  文件树（ReviewFileTree：list 平铺 / tree 文件夹树）
 *  选中文件的 diff（FileDiffPanel，max-h 55%，虚拟化行）
 *  提交条（ReviewShipBar）
 *  还原确认对话框（ConfirmDialog，破坏性）
 *
 * 与上游的差异（宿主事实）：
 * - `RightSidebarSectionHeader` / `SidebarPanelLabel` / `PaneEmptyState`
 *   （hermes 右栏外壳）→ 宿主面板没有该外壳（dockview 面板自带标签条），
 *   头部用等价的内联结构。
 * - `FileDiffPanel` 用宿主移植版（components/chat/diff-lines.tsx，同签名）。
 * - `useDelayedTrue` 用宿主版（本地 hooks）。
 * - `notifyError`（hermes 通知 store）→ 宿主没有 toast 系统 → 错误进
 *   console.error + ship bar 内联错误（禁止兜底：错误必须可见）。
 * - `closeReview`（pane-shell 关面板）→ 宿主 store 的 closeReview（清选择）；
 *   真正的面板关闭由 dockview api 完成，见 `onClose` prop。
 */

import { useDelayedTrue } from '@/hooks/use-delayed-true'
import { useReview } from '@/components/panes/review-store'
import { FileDiffPanel } from '@/components/chat/diff-lines'
import { DiffSkeleton, TreeSkeleton } from '@/components/chat/skeletons'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { DiffCount } from '@/components/ui/diff-count'
import { Tip } from '@/components/ui/tip'

import { ReviewFileTree } from './file-tree'
import { ReviewScopeRow } from './scope-row'
import { ReviewShipBar } from './ship-bar'

// Compact header/diff action buttons — micro hit targets packed tight, matching
// the rest of the app's icon-action rows.
const ACTION_BTN = 'size-5'

/** 面板空态（上游 PaneEmptyState 的等价物）。 */
function PaneEmptyState({ label }: { label: string }) {
  return (
    <div className='flex min-h-0 flex-1 items-center justify-center px-4 text-center'>
      <p className='text-[0.7rem] text-muted-foreground/60'>{label}</p>
    </div>
  )
}

export function ReviewPane({ onClose }: { onClose?: () => void }) {
  const files = useReview((s) => s.files)
  const loading = useReview((s) => s.loading)
  const isRepo = useReview((s) => s.isRepo)
  const selectedPath = useReview((s) => s.selectedPath)
  const diff = useReview((s) => s.diff)
  const diffLoading = useReview((s) => s.diffLoading)
  const revertTarget = useReview((s) => s.revertTarget)
  const treeMode = useReview((s) => s.treeMode)
  const scope = useReview((s) => s.scope)

  const toggleTreeMode = useReview((s) => s.toggleTreeMode)
  const stageFile = useReview((s) => s.stageFile)
  const unstageFile = useReview((s) => s.unstageFile)
  const requestRevert = useReview((s) => s.requestRevert)
  const cancelRevert = useReview((s) => s.cancelRevert)
  const confirmRevert = useReview((s) => s.confirmRevert)
  const clearSelection = useReview((s) => s.clearSelection)
  const refresh = useReview((s) => s.refresh)

  // Stage / unstage / revert 与提交条都作用于工作树，只对未提交 scope 有效；
  // branch / lastTurn 是只读视图。
  const isUncommitted = scope === 'uncommitted'

  const selectedFile = files.find((file) => file.path === selectedPath)
  const hasFiles = files.length > 0
  // A repo (or a load that may reveal one) gets the header + scope chrome.
  const showChrome = loading || isRepo
  // `{ path: null }` → revert all; `{ path: '…' }` → revert one file.
  const revertingAll = revertTarget?.path == null
  // Delay the skeletons so fast loads just blank → content instead of flashing.
  const showTreeSkeleton = useDelayedTrue(loading && !hasFiles)
  const showDiffSkeleton = useDelayedTrue(diffLoading)

  return (
    // 2026-11-26 用户："审查页和工具页都叠加了容器，有个背景"——dockview
    // 的 .dv-groupview 已画 --surface 卡片底；这里再叠
    // --ui-sidebar-surface-background 会把该栏提亮一层（实测 55% + 55%
    // → 79.75%）。面板内容统一透出 group 底色，不再自带背景。
    <aside
      aria-label='审查'
      className='relative flex h-full w-full min-w-0 flex-col overflow-hidden text-(--ui-text-tertiary)'
      data-slot='review-pane'
    >
      {showChrome && (
        <div className='flex h-7 shrink-0 items-center gap-1 px-2.5' data-suppress-pane-reveal-side=''>
          <div className='flex min-w-0 flex-1'>
            <span className='truncate text-[0.72rem] font-medium text-(--ui-text-secondary)'>审查</span>
          </div>
          <Tip label={treeMode === 'tree' ? '按列表查看' : '按树查看'}>
            <Button
              aria-label={treeMode === 'tree' ? '按列表查看' : '按树查看'}
              className={ACTION_BTN}
              disabled={!hasFiles}
              onClick={toggleTreeMode}
              size='icon-xs'
              variant='ghost'
            >
              <Codicon name={treeMode === 'tree' ? 'list-flat' : 'list-tree'} size='0.8125rem' />
            </Button>
          </Tip>
          <Tip label='全部暂存'>
            <Button
              aria-label='全部暂存'
              className={ACTION_BTN}
              disabled={!hasFiles || !isUncommitted}
              onClick={() => {
                void stageFile(null).catch((err) => console.error('[review] 全部暂存失败', err))
              }}
              size='icon-xs'
              variant='ghost'
            >
              <Codicon name='add' size='0.8125rem' />
            </Button>
          </Tip>
          <Tip label='全部还原'>
            <Button
              aria-label='全部还原'
              className={ACTION_BTN}
              disabled={!hasFiles || !isUncommitted}
              onClick={() => requestRevert(null)}
              size='icon-xs'
              variant='ghost'
            >
              <Codicon name='discard' size='0.8125rem' />
            </Button>
          </Tip>
          <Tip label='刷新'>
            <Button
              aria-label='刷新'
              className={ACTION_BTN}
              onClick={() => void refresh()}
              size='icon-xs'
              variant='ghost'
            >
              <Codicon name='refresh' size='0.8125rem' spinning={loading} />
            </Button>
          </Tip>
          {onClose && (
            <Button aria-label='关闭' className={ACTION_BTN} onClick={onClose} size='icon-xs' variant='ghost'>
              <Codicon name='close' size='0.8125rem' />
            </Button>
          )}
        </div>
      )}

      {showChrome && <ReviewScopeRow />}

      {showChrome ? (
        hasFiles ? (
          <ReviewFileTree />
        ) : showTreeSkeleton ? (
          <TreeSkeleton />
        ) : loading ? (
          <div className='min-h-0 flex-1' />
        ) : (
          <PaneEmptyState label='没有可显示的差异' />
        )
      ) : (
        // No repo at all → same terse empty state, just without the chrome.
        <PaneEmptyState label='没有可显示的差异' />
      )}

      {/* Selected file's diff — reuses the shiki-highlighted FileDiffPanel. */}
      {selectedFile && (
        <div className='flex max-h-[55%] shrink-0 flex-col border-t border-(--ui-stroke-secondary)'>
          <div className='flex items-center gap-1 px-2.5 py-1.5' data-suppress-pane-reveal-side=''>
            <span className='min-w-0 flex-1 truncate font-mono text-[0.66rem] text-(--ui-text-secondary)' title={selectedFile.path}>
              {selectedFile.path}
            </span>
            <DiffCount added={selectedFile.added} className='text-[0.64rem] leading-4' removed={selectedFile.removed} />
            {isUncommitted && (
              <Tip label={selectedFile.staged ? '取消暂存' : '暂存'}>
                <Button
                  aria-label={selectedFile.staged ? '取消暂存' : '暂存'}
                  className={ACTION_BTN}
                  onClick={() => {
                    void (selectedFile.staged ? unstageFile(selectedFile.path) : stageFile(selectedFile.path)).catch((err) =>
                      console.error('[review] 暂存切换失败', err),
                    )
                  }}
                  size='icon-xs'
                  variant='ghost'
                >
                  <Codicon name={selectedFile.staged ? 'remove' : 'add'} size='0.8rem' />
                </Button>
              </Tip>
            )}
            <Button aria-label='关闭' className={ACTION_BTN} onClick={clearSelection} size='icon-xs' variant='ghost'>
              <Codicon name='close' size='0.8rem' />
            </Button>
          </div>
          <div className='min-h-0 flex-1 overflow-auto px-1 pb-1'>
            {diffLoading ? (
              showDiffSkeleton ? (
                <DiffSkeleton />
              ) : null
            ) : diff ? (
              <FileDiffPanel className='mx-0 mb-0 h-full max-h-none' diff={diff} path={selectedFile.path} virtualized />
            ) : (
              <div className='py-6 text-center text-[0.66rem] text-muted-foreground/60'>没有可显示的差异</div>
            )}
          </div>
        </div>
      )}

      <ReviewShipBar />

      <ConfirmDialog
        confirmLabel={revertingAll ? '还原全部' : '还原'}
        description={
          <>
            {revertingAll
              ? '丢弃工作树里的全部未提交变更？此操作没有撤销。'
              : '丢弃这个文件的未提交变更？此操作没有撤销。'}
            {!revertingAll && revertTarget?.path && (
              <span className='mt-2 block truncate font-mono text-[0.7rem] text-(--ui-text-secondary)' title={revertTarget.path}>
                {revertTarget.path}
              </span>
            )}
          </>
        }
        destructive
        // confirmRevert 自己关对话框再在后台还原——失败进 console，不在行内。
        dismissOnConfirm
        onClose={cancelRevert}
        onConfirm={() => confirmRevert().catch((err) => console.error('[review] 还原失败', err))}
        open={revertTarget !== undefined}
        title={revertingAll ? '还原全部' : '还原'}
      />
    </aside>
  )
}
