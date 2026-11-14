/**
 * 审查的提交条 —— hermes 桌面端
 * `app/right-sidebar/review/ship-bar.tsx`（178 行）的移植。
 *
 * 提交信息（自增长 Textarea）+ 生成按钮 + 提交分体钮（提交 / 提交并推送）
 * + 交给 agent 提交 + PR 钮。
 *
 * 与上游的差异（都是宿主事实，逐条说明）：
 * 1. **AI 生成提交信息不提供**：上游 `generateCommitMessage` 走网关的
 *    会话外一次性 LLM（`llm.oneshot` template `commit_message`）。宿主 pi
 *    没有该 IPC 面 → 按钮按上游位置渲染但 **disabled**，提示文案说明原因
 *    （不造假成功、不隐藏功能位）。
 * 2. **「交给 agent 提交」不提供**：上游 `requestComposerSubmit` 把一句任务
 *    注入 composer。宿主的 composer 没有 action 注入面 → 不渲染该行（上游
 *    在没有该能力时也不渲染）。
 * 3. `SplitButton` 用宿主 beui 版（同签名）；`GenerateButton` 用宿主版。
 * 4. 只读 scope（branch / lastTurn）显示一行说明而不是整条消失——上游
 *    同样的注释理由：用户重开面板看到空白的 ship 区会以为坏了。
 */

import { useState } from 'react'

import { useReview } from '@/components/panes/review-store'
import { isReadOnlyScope } from '@/components/panes/review-store'
import { GenerateButton } from '@/components/ui/generate-button'
import { SplitButton } from '@/components/ui/split-button'
import { Textarea } from '@/components/ui/textarea'
import { Tip } from '@/components/ui/tip'
import { Codicon } from '@/components/ui/codicon'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// One size for every glyph in the bar so the row reads as a set of peers.
const ICON = '0.85rem'

export function ReviewShipBar() {
  const files = useReview((s) => s.files)
  const scope = useReview((s) => s.scope)
  const ship = useReview((s) => s.shipInfo)
  const busy = useReview((s) => s.shipBusy)
  const commitDefault = useReview((s) => s.commitDefault)
  const shipError = useReview((s) => s.shipError)
  const commitChanges = useReview((s) => s.commitChanges)
  const setCommitDefault = useReview((s) => s.setCommitDefault)
  const createOrOpenPr = useReview((s) => s.createOrOpenPr)
  const [message, setMessage] = useState('')

  const prLabel = ship.pr?.url ? '打开 PR' : '创建 PR'

  const hasFiles = files.length > 0
  const canCommit = hasFiles && message.trim().length > 0 && !busy

  // Commit / push / PR 只对工作树有意义——branch / lastTurn 是只读视图。
  if (isReadOnlyScope(scope)) {
    return (
      <div
        className='shrink-0 px-2 pb-1.5 text-center text-[0.64rem] text-(--ui-text-tertiary)'
        data-suppress-pane-reveal-side=''
      >
        只读视图 —— 暂存、还原和提交操作仅适用于「未提交」
      </div>
    )
  }

  if (!hasFiles) {
    return null
  }

  const runCommit = (action: string) => {
    if (!canCommit) return
    void commitChanges(message, action === 'commitPush').then(() => setMessage(''))
  }

  return (
    <div className='flex shrink-0 flex-col gap-1.5 p-2' data-suppress-pane-reveal-side=''>
      {/* Auto-growing message field (CSS field-sizing); generate action fills the
          right edge on one row, then sticks to the top as it grows. */}
      <div className='relative'>
        <Textarea
          className='field-sizing-content max-h-40 min-h-0 resize-none pr-9 text-xs'
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault()
              runCommit(commitDefault)
            }
          }}
          placeholder='提交信息…（Ctrl+Enter 提交）'
          rows={1}
          value={message}
        />
        <GenerateButton
          className='absolute top-px right-px h-6 w-8 rounded-l-none rounded-r-[2px]'
          disabled
          generating={false}
          iconSize={ICON}
          label='生成提交信息（宿主暂无会话外模型端点）'
          onGenerate={() => {
            console.error('[review] 生成提交信息不可用：宿主没有会话外一次性 LLM 端点')
          }}
        />
      </div>

      {/* Commit split (VS Code style). */}
      <div className='flex min-w-0'>
        <SplitButton
          actions={[
            { id: 'commit', label: '提交' },
            { id: 'commitPush', label: '提交并推送' },
          ]}
          className='min-w-0 flex-1'
          disabled={!canCommit}
          onTrigger={runCommit}
          onValueChange={(id) => setCommitDefault(id === 'commitPush' ? 'commitPush' : 'commit')}
          primaryIcon={<Codicon name='check' size={ICON} />}
          value={commitDefault}
          variant='default'
        />
      </div>

      {/* PR 钮：gh 不可用时禁用（与上游同语义），有 PR 则打开，否则创建。 */}
      <div className='relative flex min-w-0 items-center justify-end'>
        <Tip label={ship.ghReady ? prLabel : 'gh CLI 不可用或未登录'}>
          <Button
            aria-label={prLabel}
            className={cn('size-7 text-muted-foreground/80 hover:text-foreground')}
            disabled={!ship.ghReady || busy}
            onClick={() => void createOrOpenPr()}
            size='icon-xs'
            variant='ghost'
          >
            <Codicon name='git-pull-request' size={ICON} />
          </Button>
        </Tip>
      </div>

      {shipError !== null && (
        <div className='rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-[0.68rem] text-destructive' role='alert'>
          {shipError}
        </div>
      )}
    </div>
  )
}
