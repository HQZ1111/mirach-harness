/**
 * 「管理配置档案」页（hermes `app/profiles/index.tsx` 的宿主移植，
 * 2026-11-26 用户："管理配置档案怎么是假的"）。
 *
 * 结构照上游：左侧列表（搜索 / 首字色块 / 行菜单 重命名·删除 / 新建）+
 * 右侧详情（名称/默认徽章/路径/模型/技能数 + 内联 SOUL.md 编辑器）。
 * 数据面 = botsStore（BotPreset = 宿主 profile）+ `pi_profile_info`
 * （home 路径 / 技能计数）+ `pi_profile_rename/delete/export/import`。
 *
 * 与上游的差异只在宿主能力边界：默认档案的「重命名」= 显示名称
 * （canonical id 仍是 default，hermes displayNameTitle 同语义）；没有
 * env 徽章 / 远端覆盖 / fleet 段（宿主没有这些数据面）。
 */
import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

import { errorBridge } from '@/components/assistant-ui/error-bridge'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/motion/context-menu'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tip } from '@/components/ui/tip'
import {
  botDisplayName,
  botsStore,
  DEFAULT_BOT_NAME,
  type BotPreset,
  useBotsStore,
} from '@/components/panes/hub/bots-store'
import { openBotsPanel } from '@/components/panes/hub/bots-panel-actions'
import {
  switchProfileBridge,
  useActiveProfile,
} from '@/components/panes/session-manage/active-profile-bridge'
import { requestBotsAction } from '@/plugins/bots-request-bridge'
import { selectBotsRoster } from '@/plugins/bots-selection-bridge'
import {
  profileColorSoft,
  PROFILE_SWATCHES,
  resolveProfileColor,
} from '@/lib/profile-color'
import { profileShortLabel } from '@/lib/profile-short-label'
import {
  setProfileRailColor,
  useProfileRailColors,
  useProfileRailOrder,
} from '@/lib/profile-rail-pref'
import { renameBotProfile } from '@/sdk/host-rpc'

import { NoticeDialog, RenameProfileDialog } from './profile-dialogs'

interface ProfileInfo {
  name: string
  path: string
  exists: boolean
  skills: number
}

function sortBots(bots: readonly BotPreset[], order: readonly string[]): BotPreset[] {
  const rank = new Map(order.map((name, index) => [name, index]))
  const named = bots
    .filter((bot) => bot.name !== DEFAULT_BOT_NAME)
    .sort((a, b) => (rank.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.name) ?? Number.MAX_SAFE_INTEGER))
  const defaults = bots.filter((bot) => bot.name === DEFAULT_BOT_NAME)
  return [...defaults, ...named]
}

function ProfileGlyph({ bot, colors }: { bot: BotPreset; colors: Record<string, string> }) {
  const color = resolveProfileColor(bot.name, colors)
  const isDefault = bot.name === DEFAULT_BOT_NAME
  return (
    <span
      aria-hidden
      className="grid size-4 shrink-0 place-items-center rounded-[3px] text-[0.5rem] font-semibold uppercase leading-none"
      style={{
        backgroundColor: profileColorSoft(color ?? 'var(--ui-text-quaternary)', 22),
        color: color ?? undefined,
      }}
    >
      {isDefault ? <span className="text-(--ui-text-quaternary)">⌂</span> : profileShortLabel(botDisplayName(bot))}
    </span>
  )
}

export function ProfilesPage() {
  const bots = useBotsStore((s) => s.bots)
  const colors = useProfileRailColors()
  const order = useProfileRailOrder()
  const activeProfile = useActiveProfile()

  const sorted = useMemo(() => sortBots(bots, order), [bots, order])
  const [selectedName, setSelectedName] = useState<null | string>(null)
  const [query, setQuery] = useState('')
  const [info, setInfo] = useState<ProfileInfo | null>(null)
  const [infoError, setInfoError] = useState<null | string>(null)
  const [renaming, setRenaming] = useState<BotPreset | null>(null)
  const [deleting, setDeleting] = useState<BotPreset | null>(null)
  const [notice, setNotice] = useState<null | string>(null)

  const selected = sorted.find((bot) => bot.name === selectedName) ?? sorted[0] ?? null

  // 选中项失效（删除/改名）时回落到本体或第一项。
  useEffect(() => {
    if (selectedName && !sorted.some((bot) => bot.name === selectedName)) {
      setSelectedName(sorted[0]?.name ?? null)
    }
  }, [selectedName, sorted])

  useEffect(() => {
    if (!selected) {
      setInfo(null)
      return
    }
    let cancelled = false
    setInfo(null)
    setInfoError(null)
    void invoke<ProfileInfo>('pi_profile_info', { name: selected.name })
      .then((next) => {
        if (!cancelled) setInfo(next)
      })
      .catch((e: unknown) => {
        if (!cancelled) setInfoError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [selected?.name])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return sorted
    return sorted.filter(
      (bot) =>
        botDisplayName(bot).toLowerCase().includes(q) ||
        bot.name.toLowerCase().includes(q) ||
        (bot.model ?? '').toLowerCase().includes(q),
    )
  }, [query, sorted])

  const submitRename = async (bot: BotPreset, next: string): Promise<void> => {
    if (bot.name === DEFAULT_BOT_NAME) {
      botsStore.getState().patchMeta(DEFAULT_BOT_NAME, { title: next })
      return
    }
    const wasActive = activeProfile === bot.name
    if (wasActive) {
      const ok = await switchProfileBridge(null)
      if (!ok) throw new Error('切换到默认环境失败，未重命名')
      selectBotsRoster(null)
    }
    await renameBotProfile(bot.name, next)
    botsStore.getState().load()
    setSelectedName(next)
    if (wasActive) {
      const ok = await switchProfileBridge(next)
      if (ok) selectBotsRoster(next)
    }
  }

  const deleteProfile = async (bot: BotPreset): Promise<void> => {
    if (bot.name === DEFAULT_BOT_NAME) throw new Error('默认环境不可删除')
    if (activeProfile === bot.name) {
      const ok = await switchProfileBridge(null)
      if (!ok) throw new Error('切换到默认环境失败，未删除')
      selectBotsRoster(null)
    }
    const { host } = await import('@/sdk/host')
    await host.deleteProfile(bot.name)
    botsStore.getState().load()
    setSelectedName(null)
  }

  const saveSoul = async (bot: BotPreset, content: string): Promise<void> => {
    const current = botsStore.getState().bots.find((candidate) => candidate.name === bot.name) ?? bot
    botsStore.getState().upsert({ ...current, systemPrompt: content })
    setNotice(`「${botDisplayName(current)}」的 SOUL.md 已保存（下次新会话生效）`)
  }

  const createProfile = (): void => {
    openBotsPanel()
    requestBotsAction({ kind: 'create' })
  }

  const importProfile = async (): Promise<void> => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const archive = await open({
        title: '导入配置档案',
        multiple: false,
        filters: [{ name: 'Mirach profile', extensions: ['tar.gz', 'tgz'] }],
      })
      if (!archive || Array.isArray(archive)) return
      const result = await invoke<{ name: string }>('pi_profile_import', { archive })
      if (!botsStore.getState().bots.some((bot) => bot.name === result.name)) {
        botsStore.getState().upsert({
          name: result.name,
          title: '',
          systemPrompt: '',
          model: '',
          cwd: '',
          description: '导入的配置档案',
          createdAt: Date.now(),
        })
      }
      botsStore.getState().load()
      setSelectedName(result.name)
      setNotice(`已导入配置档案「${result.name}」`)
    } catch (e) {
      errorBridge
        .getState()
        .setError(`导入配置档案失败：${e instanceof Error ? e.message : String(e)}`, false)
    }
  }

  const exportProfile = async (bot: BotPreset): Promise<void> => {
    try {
      const { save } = await import('@tauri-apps/plugin-dialog')
      const output = await save({
        title: '导出配置档案',
        defaultPath: `${bot.name}.tar.gz`,
        filters: [{ name: 'Mirach profile', extensions: ['tar.gz', 'tgz'] }],
      })
      if (!output) return
      const result = await invoke<{ archive: string }>('pi_profile_export', {
        name: bot.name,
        output,
      })
      setNotice(`已导出配置档案「${botDisplayName(bot)}」→ ${result.archive}`)
    } catch (e) {
      errorBridge
        .getState()
        .setError(`导出配置档案失败：${e instanceof Error ? e.message : String(e)}`, false)
    }
  }

  return (
    <div className="flex h-full min-h-0 bg-(--surface)" data-slot="profiles-page">
      <aside className="flex w-64 shrink-0 flex-col border-r border-(--stroke-soft)">
        <div className="flex items-center justify-between px-3 pb-1 pt-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">配置档案</div>
            <div className="text-[0.65rem] text-(--ui-text-tertiary)">{bots.length} 个配置档案</div>
          </div>
          <Tip label="新建配置档案">
            <Button aria-label="新建配置档案" onClick={createProfile} size="icon-xs" type="button" variant="ghost">
              +
            </Button>
          </Tip>
        </div>
        <div className="px-2 pb-2 pt-1">
          <Input
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索配置档案…"
            value={query}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {visible.map((bot) => {
            const active = selected?.name === bot.name
            const isDefault = bot.name === DEFAULT_BOT_NAME
            return (
              <div
                className={
                  'group flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs transition-colors ' +
                  (active
                    ? 'bg-(--ui-control-active-background) text-foreground'
                    : 'text-(--ui-text-secondary) hover:bg-(--ui-control-hover-background)')
                }
                data-profile-row={bot.name}
                key={bot.name}
                onClick={() => setSelectedName(bot.name)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') setSelectedName(bot.name)
                }}
              >
                <ProfileGlyph bot={bot} colors={colors} />
                <span className="min-w-0 flex-1 truncate">{botDisplayName(bot)}</span>
                {isDefault && (
                  <span className="rounded bg-(--ui-bg-quinary) px-1 text-[0.6rem] text-(--ui-text-tertiary)">
                    默认
                  </span>
                )}
                <ContextMenu align="end" anchor="trigger" side="bottom">
                  <ContextMenuTrigger>
                    <button
                      aria-label={`${botDisplayName(bot)} 操作`}
                      className="grid size-5 shrink-0 place-items-center rounded text-(--ui-text-tertiary) opacity-0 hover:bg-(--ui-control-hover-background) hover:text-foreground group-hover:opacity-100"
                      onClick={(event) => event.stopPropagation()}
                      type="button"
                    >
                      ⋯
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent ariaLabel="档案操作" className="w-40">
                    <ContextMenuItem onSelect={() => setRenaming(bot)}>
                      <span>{isDefault ? '编辑显示名称…' : '重命名…'}</span>
                    </ContextMenuItem>
                    {!isDefault && (
                      <ContextMenuItem onSelect={() => setDeleting(bot)} tone="destructive">
                        <span>删除</span>
                      </ContextMenuItem>
                    )}
                  </ContextMenuContent>
                </ContextMenu>
              </div>
            )
          })}
          <button
            className="mt-1 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
            onClick={createProfile}
            type="button"
          >
            <span className="grid size-4 place-items-center">+</span>
            新建配置档案
          </button>
          <button
            className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
            onClick={() => void importProfile()}
            type="button"
          >
            <span className="grid size-4 place-items-center">↓</span>
            导入配置档案…
          </button>
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto p-4">
        {selected ? (
          <div className="mx-auto max-w-3xl space-y-4">
            <header className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-[0.95rem] font-semibold tracking-tight text-foreground">
                  {botDisplayName(selected)}
                </h2>
                {selected.name === DEFAULT_BOT_NAME && (
                  <span className="rounded bg-(--ui-bg-quinary) px-1.5 py-0.5 text-[0.65rem] text-(--ui-text-tertiary)">
                    默认
                  </span>
                )}
                <span className="font-mono text-[0.65rem] text-(--ui-text-tertiary)">{selected.name}</span>
              </div>
              <p className="truncate font-mono text-[0.66rem] text-(--ui-text-tertiary)" title={info?.path ?? ''}>
                {infoError ? `路径读取失败：${infoError}` : info?.path ?? '…'}
              </p>
              <div className="grid gap-1 text-xs text-(--ui-text-secondary)">
                <div>
                  <span className="text-(--ui-text-tertiary)">模型：</span>
                  {selected.model ? <span className="font-mono">{selected.model}</span> : '未设置'}
                </div>
                <div>
                  <span className="text-(--ui-text-tertiary)">技能：</span>
                  {info ? `${info.skills} 个` : '…'}
                </div>
                {selected.name !== DEFAULT_BOT_NAME && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-(--ui-text-tertiary)">颜色：</span>
                    {PROFILE_SWATCHES.map((swatch) => (
                      <button
                        aria-label={`设置颜色 ${swatch}`}
                        className="size-4 rounded-full transition-transform hover:scale-110"
                        key={swatch}
                        onClick={() => setProfileRailColor(selected.name, swatch)}
                        style={{ backgroundColor: swatch }}
                        type="button"
                      />
                    ))}
                    <button
                      className="rounded px-1 text-[0.65rem] text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-foreground"
                      onClick={() => setProfileRailColor(selected.name, null)}
                      type="button"
                    >
                      自动
                    </button>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5 pt-1">
                <Button onClick={() => setRenaming(selected)} size="xs" type="button" variant="outline">
                  {selected.name === DEFAULT_BOT_NAME ? '编辑显示名称…' : '重命名…'}
                </Button>
                {selected.name !== DEFAULT_BOT_NAME && (
                  <>
                    <Button
                      onClick={() => void exportProfile(selected)}
                      size="xs"
                      type="button"
                      variant="outline"
                    >
                      导出…
                    </Button>
                    <Button
                      onClick={() => setDeleting(selected)}
                      size="xs"
                      type="button"
                      variant="outline"
                    >
                      删除
                    </Button>
                  </>
                )}
              </div>
            </header>

            <SoulEditor bot={selected} onSave={saveSoul} />
          </div>
        ) : (
          <div className="grid h-full place-items-center text-xs text-(--ui-text-tertiary)">
            选择一个配置档案以查看其详情。
          </div>
        )}
      </section>

      <RenameProfileDialog bot={renaming} onClose={() => setRenaming(null)} onSubmit={submitRename} />
      <ConfirmDialog
        confirmLabel="删除"
        description={
          deleting
            ? `这将永久移除「${botDisplayName(deleting)}」及其配置档案目录（${deleting.name}）。此操作无法撤销。`
            : undefined
        }
        destructive
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await deleteProfile(deleting)
        }}
        open={deleting !== null}
        title="删除配置档案？"
      />
      <NoticeDialog message={notice} onClose={() => setNotice(null)} />
    </div>
  )
}

/** 内联 SOUL 编辑器（hermes ProfileDetail 的 SoulEditor 宿主版）。 */
function SoulEditor({
  bot,
  onSave,
}: {
  bot: BotPreset
  onSave: (bot: BotPreset, content: string) => Promise<void>
}) {
  const [content, setContent] = useState(bot.systemPrompt ?? '')
  const [original, setOriginal] = useState(bot.systemPrompt ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<null | string>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setContent(bot.systemPrompt ?? '')
    setOriginal(bot.systemPrompt ?? '')
    setError(null)
    setSaved(false)
  }, [bot.name])

  const dirty = content !== original

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      await onSave(bot, content)
      setOriginal(content)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[0.7rem] font-semibold uppercase tracking-[0.14em] text-(--ui-text-tertiary)">
            SOUL.md
          </div>
          <p className="text-xs text-(--ui-text-tertiary)">
            此配置档案的系统提示词与人格指令。留空则使用默认值。
          </p>
        </div>
        {dirty && <span className="text-[0.65rem] text-(--ui-text-tertiary)">有未保存的更改</span>}
      </div>
      <Textarea
        className="min-h-64 font-mono text-xs"
        onChange={(event) => {
          setContent(event.target.value)
          setSaved(false)
        }}
        placeholder="SOUL.md 内容…"
        value={content}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        {saved && <span className="text-[0.65rem] text-(--ui-text-tertiary)">已保存</span>}
        <Button disabled={!dirty || saving} onClick={() => void save()} size="sm" type="button">
          {saving ? '保存中…' : '保存 SOUL.md'}
        </Button>
      </div>
    </section>
  )
}
