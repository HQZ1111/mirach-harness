/**
 * 「技能与工具」= 纯本地清单（2026-11-26 用户："技能与工具页面还有很多
 * hermes 的东西，只显示本地仓库的，去掉没用的"）。
 *
 * 旧页面直接嵌 hermes `CapabilitiesView`：四个页签（技能 / 插件 / 连接器 /
 * 工具集）、Skills Hub 目录、Optional 分类、scope selector、安装/更新按钮——
 * 这些数据面在宿主都不存在（pi 的技能就是本地 `skills/` 目录，插件/连接器
 * 没有对偶）。现在保留 hermes 同形的顶部页签（技能 / 工具 / 插件），内容只
 * 来自 `pi_capabilities` 与 `pi_extensions` 的真实本地清单：
 *   · 技能：本机 home `skills/` + 当前工作区 `.rpi/skills` 的已装技能，
 *     名称/描述/来源/路径 + 启用开关（`pi_set_skill_enabled`）；
 *   · 工具集：引擎内置工具组 + 开关（`pi_set_toolset_enabled`）；
 *   · 加载诊断（有才显示）。
 *
 * 与「设置 → 技能与工具」同一份数据与开关，但这是主区整页（带搜索、刷新）。
 * 没有 hermes 的 Hub / 插件 / 连接器 / 账号 / 安装按钮——不放假入口。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '@nanostores/react'
import { RefreshCwIcon, SearchIcon } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  $pluginDecisions,
  setPluginEnabled,
} from '@/hermes-shim/contrib/plugins-store'
import { TextTab, TextTabMeta } from '@/hermes-mirror/components/ui/text-tab'

interface ToolsetRow {
  key: string
  label: string
  description: string
  enabled: boolean
  needsSetup: boolean
  configured: boolean
  tools: string[]
}

interface SkillRow {
  name: string
  description: string
  path: string
  source: 'global' | 'project' | string
  enabled: boolean
  disableModelInvocation?: boolean
}

interface CapabilitiesSnapshot {
  agentDir: string
  skillsDir: string
  skills: SkillRow[]
  toolsets: ToolsetRow[]
  diagnostics: { kind: string; message: string; path?: string }[]
}

/** `pi_extensions` 行（宿主原生扩展 = 插件：hermes-bots / radio / …）。 */
interface ExtensionRow {
  extensionId: string
  name: string
  version: string
  description: string
  runtime: string
  entry: string
  root: string
  capabilities: string[]
  file: string
  sizeBytes: number
  modifiedMs: number
  abi: number | null
  repository: string | null
  target: string | null
  source: string | null
  registered: boolean
}

interface ExtensionsSnapshot {
  extensions: ExtensionRow[]
  diagnostics: { message: string; path: string }[]
  dir: string
  registry: string
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

type CapabilityTab = 'skills' | 'tools' | 'plugins'

export function LocalCapabilitiesPane() {
  const [snapshot, setSnapshot] = useState<CapabilitiesSnapshot | null>(null)
  const [extensions, setExtensions] = useState<ExtensionsSnapshot | null>(null)
  const [extensionsError, setExtensionsError] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // 顶部页签 = hermes CapabilitiesView 的页签条（技能 / 插件 / 连接器 /
  // 工具集）。宿主没有连接器页签（hermes 的网关↔MCP 连接宿主不存在），
  // 所以只保留三个真实数据面：技能、工具（工具集）、插件（应用内置 +
  // 原生扩展）。
  const [tab, setTab] = useState<CapabilityTab>('skills')
  const decisions = useStore($pluginDecisions)
  const botsPluginEnabled = 'hermes-bots' in decisions ? decisions['hermes-bots'] === true : true
  const radioPluginEnabled = 'hermes-radio' in decisions ? decisions['hermes-radio'] === true : true

  const load = useCallback(() => {
    const nextCapabilities = invoke<CapabilitiesSnapshot>('pi_capabilities')
      .then((next) => {
        setSnapshot(next)
        setLoadError(null)
      })
      .catch((e: unknown) => {
        console.error('[capabilities] 读取失败', e)
        setLoadError(describeError(e))
      })
    // 插件 = 活动环境 home 的 extensions/ 原生扩展（bots / radio / …）。
    // 与"工具"完全分开：工具是引擎内置 toolset，插件是 DLL 扩展。
    const nextExtensions = invoke<ExtensionsSnapshot>('pi_extensions', {})
      .then((next) => {
        setExtensions(next)
        setExtensionsError(null)
      })
      .catch((e: unknown) => {
        console.error('[capabilities] 扩展列表读取失败', e)
        setExtensionsError(describeError(e))
      })
    return Promise.all([nextCapabilities, nextExtensions])
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const toggleToolset = (row: ToolsetRow, enabled: boolean) => {
    setBusy(`toolset:${row.key}`)
    setActionError(null)
    void invoke('pi_set_toolset_enabled', { key: row.key, enabled })
      .then(() => load())
      .catch((e: unknown) => {
        console.error('[capabilities] 工具集开关失败', e)
        setActionError(`${row.label}：${describeError(e)}`)
      })
      .finally(() => setBusy(null))
  }

  const toggleSkill = (row: SkillRow, enabled: boolean) => {
    setBusy(`skill:${row.name}`)
    setActionError(null)
    void invoke('pi_set_skill_enabled', { name: row.name, enabled })
      .then(() => load())
      .catch((e: unknown) => {
        console.error('[capabilities] 技能开关失败', e)
        setActionError(`${row.name}：${describeError(e)}`)
      })
      .finally(() => setBusy(null))
  }

  /** 应用内置插件（hermes-bots）：真实 pluginActive 决策 + 激活/停用句柄。 */
  const toggleBotsPlugin = (enabled: boolean) => {
    setBusy('plugin:hermes-bots')
    setActionError(null)
    void setPluginEnabled('hermes-bots', enabled)
      .catch((e: unknown) => {
        console.error('[capabilities] 插件开关失败', e)
        setActionError(`Bots：${describeError(e)}`)
      })
      .finally(() => setBusy(null))
  }

  /** 收音机 = hermes radio 插件的宿主窗格；给它一个真实启用决策
   *  （默认开）。关闭时 DockviewShell 移除已开电台窗格，打开页/标签条+
   *  也不再列入口。 */
  const toggleRadioPlugin = (enabled: boolean) => {
    setBusy('plugin:hermes-radio')
    setActionError(null)
    void setPluginEnabled('hermes-radio', enabled)
      .catch((e: unknown) => {
        console.error('[capabilities] 插件开关失败', e)
        setActionError(`收音机：${describeError(e)}`)
      })
      .finally(() => setBusy(null))
  }

  const q = query.trim().toLowerCase()
  const skills = useMemo(
    () =>
      (snapshot?.skills ?? []).filter(
        (row) =>
          !q ||
          row.name.toLowerCase().includes(q) ||
          (row.description ?? '').toLowerCase().includes(q),
      ),
    [snapshot?.skills, q],
  )
  const toolsets = useMemo(
    () =>
      (snapshot?.toolsets ?? []).filter(
        (row) =>
          !q ||
          row.label.toLowerCase().includes(q) ||
          row.description.toLowerCase().includes(q) ||
          row.tools.some((tool) => tool.toLowerCase().includes(q)),
      ),
    [snapshot?.toolsets, q],
  )
  const plugins = useMemo(
    () =>
      (extensions?.extensions ?? []).filter(
        (row) =>
          !q ||
          row.name.toLowerCase().includes(q) ||
          row.file.toLowerCase().includes(q) ||
          (row.description ?? '').toLowerCase().includes(q),
      ),
    [extensions?.extensions, q],
  )
  const toolCount = (snapshot?.toolsets ?? []).reduce((sum, row) => sum + row.tools.length, 0)
  const diagnostics = [
    ...(snapshot?.diagnostics ?? []),
    ...((extensions?.diagnostics ?? []).map((row) => ({
      kind: '插件',
      message: row.message,
      path: row.path,
    }))),
  ]

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="local-capabilities-pane">
      {/* 无标题：页面直接以页签条开头。顶部 21px 让 TextTab 的视觉中心
          （约 47px）与其它栏 dockview 标签文字中心（条高 75 的居中位）
          对齐——这些页面是 hideHeader 组，内容从卡片顶起，不补这段就会
          比别的栏标签高一整行。 */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-[21px] pb-1.5">
        <nav
          aria-label="技能与工具页签"
          className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1"
          data-slot="local-capabilities-tabs"
          role="tablist"
        >
          <TextTab
            active={tab === 'skills'}
            aria-selected={tab === 'skills'}
            data-tour="tab-skills"
            onClick={() => setTab('skills')}
            role="tab"
          >
            技能{snapshot !== null && <TextTabMeta>{snapshot.skills.length}</TextTabMeta>}
          </TextTab>
          <TextTab
            active={tab === 'tools'}
            aria-selected={tab === 'tools'}
            data-tour="tab-tools"
            onClick={() => setTab('tools')}
            role="tab"
          >
            工具
            {snapshot !== null && (
              <TextTabMeta>{`${snapshot.toolsets.length} 组 / ${toolCount}`}</TextTabMeta>
            )}
          </TextTab>
          <TextTab
            active={tab === 'plugins'}
            aria-selected={tab === 'plugins'}
            data-tour="tab-plugins"
            onClick={() => setTab('plugins')}
            role="tab"
          >
            插件
            {extensions !== null && <TextTabMeta>{2 + extensions.extensions.length}</TextTabMeta>}
          </TextTab>
        </nav>
        <div className="relative w-56 max-w-full">
          <SearchIcon className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-(--ui-text-tertiary)" />
          <Input
            className="pl-7"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索技能、工具或插件…"
            value={query}
          />
        </div>
        <Button
          aria-label="刷新"
          disabled={snapshot === null && loadError === null}
          onClick={() => void load()}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <RefreshCwIcon className="size-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-5 px-4 py-4">
          {loadError !== null && <div className="set-err">能力清单读取失败：{loadError}</div>}
          {actionError !== null && <div className="set-err">{actionError}</div>}
          {snapshot === null && loadError === null && (
            <div className="py-8 text-center text-xs text-(--ui-text-tertiary)">加载中…</div>
          )}

          {snapshot !== null && (
            <>
              <section className={tab === 'skills' ? 'space-y-2' : 'hidden'} data-tab-panel="skills">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-xs font-semibold text-foreground">技能</h3>
                  <span className="text-[0.65rem] text-(--ui-text-tertiary)">
                    {snapshot.skills.length} 个 · {snapshot.skillsDir}
                  </span>
                </div>
                <div className="rounded-lg border border-(--stroke-soft) bg-(--surface-shell)">
                  {skills.length === 0 && (
                    <div className="px-3 py-4 text-xs text-(--ui-text-tertiary)">
                      {q ? '没有匹配的技能。' : '尚未发现技能。技能目录是空的。'}
                    </div>
                  )}
                  {skills.map((row) => (
                    <div
                      className="flex items-start gap-3 border-b border-(--stroke-soft) px-3 py-2.5 last:border-b-0"
                      data-skill-row={row.name}
                      key={row.name}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-medium text-foreground">{row.name}</span>
                          <span className="rounded bg-(--ui-bg-quinary) px-1 text-[0.6rem] text-(--ui-text-tertiary)">
                            {row.source === 'project' ? '项目技能' : '全局技能'}
                          </span>
                          {row.disableModelInvocation && (
                            <span className="rounded bg-(--ui-bg-quinary) px-1 text-[0.6rem] text-(--ui-text-tertiary)">
                              仅手动调用
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[0.7rem] text-(--ui-text-secondary)">
                          {row.description || '（无描述）'}
                        </p>
                        <p className="mt-0.5 truncate font-mono text-[0.6rem] text-(--ui-text-tertiary)" title={row.path}>
                          {row.path}
                        </p>
                      </div>
                      <Switch
                        aria-label={`启用技能 ${row.name}`}
                        checked={row.enabled}
                        disabled={busy === `skill:${row.name}`}
                        onCheckedChange={(on) => toggleSkill(row, on)}
                      />
                    </div>
                  ))}
                </div>
              </section>

              <section className={tab === 'tools' ? 'space-y-2' : 'hidden'} data-tab-panel="tools">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-xs font-semibold text-foreground">工具</h3>
                  <span className="text-[0.65rem] text-(--ui-text-tertiary)">
                    {snapshot.toolsets.length} 组 / {toolCount} 个 · 引擎内置
                  </span>
                </div>
                <div className="rounded-lg border border-(--stroke-soft) bg-(--surface-shell)">
                  {toolsets.length === 0 && (
                    <div className="px-3 py-4 text-xs text-(--ui-text-tertiary)">没有匹配的工具。</div>
                  )}
                  {toolsets.map((row) => (
                    <div
                      className="flex items-start gap-3 border-b border-(--stroke-soft) px-3 py-2.5 last:border-b-0"
                      data-toolset-row={row.key}
                      key={row.key}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-medium text-foreground">{row.label}</span>
                          <span className="rounded bg-(--ui-bg-quinary) px-1 text-[0.6rem] text-(--ui-text-tertiary)">
                            {row.tools.length} 个工具
                          </span>
                          {row.needsSetup && (
                            <span className="rounded bg-(--ui-bg-quinary) px-1 text-[0.6rem] text-(--ui-text-tertiary)">
                              需要引擎配置后才真正可用
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-[0.7rem] text-(--ui-text-secondary)">{row.description}</p>
                        {row.tools.length > 0 && (
                          <div className="mt-1 flex flex-wrap gap-1" data-tools={row.tools.join(',')}>
                            {row.tools.map((tool) => (
                              <span
                                className="rounded bg-(--ui-bg-quinary) px-1 py-0.5 font-mono text-[0.6rem] text-(--ui-text-secondary)"
                                key={tool}
                              >
                                {tool}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                      <Switch
                        aria-label={`启用工具集 ${row.label}`}
                        checked={row.enabled}
                        disabled={busy === `toolset:${row.key}`}
                        onCheckedChange={(on) => toggleToolset(row, on)}
                      />
                    </div>
                  ))}
                </div>
              </section>

              <section className={tab === 'plugins' ? 'space-y-2' : 'hidden'} data-tab-panel="plugins">
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-xs font-semibold text-foreground">插件</h3>
                  <span className="text-[0.65rem] text-(--ui-text-tertiary)">应用内置 + 原生扩展</span>
                </div>

                {/* 应用内置插件：Bots 是 bundled 插件（真实开关）；收音机是
                    hermes radio 插件的宿主窗格形态，用同一套启用决策
                    （`hermes-radio`，默认开）——关闭会移除已开窗格并隐藏
                    打开页/标签条入口。 */}
                <div className="rounded-lg border border-(--stroke-soft) bg-(--surface-shell)">
                  <div className="flex items-start gap-3 border-b border-(--stroke-soft) px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-medium text-foreground">Bots</span>
                        <span className="rounded bg-(--ui-bg-quinary) px-1 text-[0.6rem] text-(--ui-text-tertiary)">
                          内置插件
                        </span>
                      </div>
                      <p className="mt-0.5 text-[0.7rem] text-(--ui-text-secondary)">
                        机器人花名册、Bot Chat 与群聊（hermes-bots）
                      </p>
                    </div>
                    <Switch
                      aria-label="启用插件 Bots"
                      checked={botsPluginEnabled}
                      disabled={busy === 'plugin:hermes-bots'}
                      onCheckedChange={toggleBotsPlugin}
                    />
                  </div>
                  <div className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs font-medium text-foreground">收音机</span>
                        <span className="rounded bg-(--ui-bg-quinary) px-1 text-[0.6rem] text-(--ui-text-tertiary)">
                          内置窗格
                        </span>
                      </div>
                      <p className="mt-0.5 text-[0.7rem] text-(--ui-text-secondary)">
                        电台搜索与播放（hermes radio 插件的宿主窗格）
                      </p>
                    </div>
                    <Switch
                      aria-label="启用插件 收音机"
                      checked={radioPluginEnabled}
                      disabled={busy === 'plugin:hermes-radio'}
                      onCheckedChange={toggleRadioPlugin}
                    />
                  </div>
                </div>

                <div className="flex items-baseline justify-between gap-2 pt-1">
                  <h4 className="text-[0.7rem] font-semibold text-(--ui-text-secondary)">
                    原生扩展（本机 extensions/）
                  </h4>
                  <span
                    className="max-w-[60%] truncate text-[0.65rem] text-(--ui-text-tertiary)"
                    title={extensions?.dir}
                  >
                    {extensions ? `${extensions.extensions.length} 个 · ${extensions.dir}` : '读取中…'}
                  </span>
                </div>
                <div className="rounded-lg border border-(--stroke-soft) bg-(--surface-shell)">
                  {extensionsError !== null && (
                    <div className="px-3 py-4 text-xs text-destructive">插件目录读取失败：{extensionsError}</div>
                  )}
                  {extensions !== null && plugins.length === 0 && (
                    <div className="px-3 py-4 text-xs text-(--ui-text-tertiary)">
                      {q ? '没有匹配的原生扩展。' : '当前环境的 extensions/ 目录是空的。'}
                    </div>
                  )}
                  {plugins.map((row) => (
                    <div
                      className="flex items-start gap-3 border-b border-(--stroke-soft) px-3 py-2.5 last:border-b-0"
                      data-plugin-row={row.name}
                      key={row.extensionId}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-xs font-medium text-foreground">{row.name}</span>
                          {row.version && (
                            <span className="font-mono text-[0.6rem] text-(--ui-text-tertiary)">v{row.version}</span>
                          )}
                          <span className="rounded bg-(--ui-bg-quinary) px-1 text-[0.6rem] text-(--ui-text-tertiary)">
                            {row.runtime}
                          </span>
                          {!row.registered && (
                            <span className="rounded bg-(--ui-bg-quinary) px-1 text-[0.6rem] text-(--ui-text-tertiary)">
                              未登记（手动放入）
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate font-mono text-[0.6rem] text-(--ui-text-tertiary)" title={row.entry}>
                          {row.file} · {formatBytes(row.sizeBytes)}
                          {row.repository ? ` · ${row.repository}` : ''}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </section>

              {diagnostics.length > 0 && (
                <section className="space-y-2">
                  <h3 className="text-xs font-semibold text-foreground">加载诊断</h3>
                  <div className="rounded-lg border border-(--stroke-soft) bg-(--surface-shell)">
                    {diagnostics.map((d, index) => (
                      <div className="border-b border-(--stroke-soft) px-3 py-2 text-xs last:border-b-0" key={`${d.kind}-${index}`}>
                        <div className="font-medium text-foreground">{d.kind}</div>
                        <div className="text-(--ui-text-secondary)">{d.message}</div>
                        {d.path && (
                          <div className="truncate font-mono text-[0.6rem] text-(--ui-text-tertiary)" title={d.path}>
                            {d.path}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
