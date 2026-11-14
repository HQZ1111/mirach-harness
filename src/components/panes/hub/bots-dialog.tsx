/**
 * 机器人新建/编辑表单（BotsDialog）——hermes plugins/hermes-bots
 * create-dialog.tsx CreateAgentDialog（:283-1148）的结构逐段照抄
 * （2026-11-10 完整结构轮）：
 *
 * | hermes | 本表单 |
 * |---|---|
 * | DialogHeader：标题 + DialogDescription | ✅（描述宿主化：保存=预设入库，启动=以该配置开会话） |
 * | body = dialog grid gap-3 p-4；主栈 gap-3.5；labeled() 字段（grid gap-1.5 + label text-xs font-medium） | ✅ |
 * | BotFace 56 预览（flex justify-center py-1）+ AvatarPicker（形状/颜色/图片） | ✅（宿主版 AvatarPicker） |
 * | labeled(name) + taken 提示 | ✅ |
 * | [多连接] labeled(createOn, Select) + remoteHint | ✅（远端红显占位） |
 * | labeled(title) / labeled(description, Textarea min-h-16) | ✅ |
 * | **Advanced 折叠钮**（text 钮 + DisclosureCaret，:842-858） | ✅ |
 * | 展开容器（rounded-md border p-3 grid gap-3）+ **SegmentedControl [常规/技能/工具/MCP]** | ✅ |
 * | 常规页：cloneFrom Select + ModelPicker | 模型 = catalog select（宿主无 clone 来源——pi 无 profile 森林，不造）；+ System prompt（pi SessionOptions.system_prompt 真面）+ 工作区 |
 * | 技能页：CheckList（已装技能） | ✅（pi_capabilities 真清单；启动拼进 system prompt） |
 * | 工具页：toolsets CheckList | ✅（pi_capabilities 真分组；**启动经 pi_create_bot_session enabledTools 映射 SessionOptions.enabled_tools——真生效**） |
 * | MCP 页：McpSetupButton / catalog | 红显占位（pi 无 per-bot MCP 装载面） |
 * | 高级态 max-w-3xl + resize:both | ✅（同款尺寸/缩放手势） |
 *
 * 提交 = botsStore.upsert（预设落盘）→ callbacks.launched（bots-pane 接管
 * 启动会话）。hermes 的"创建即开天初始对话"——宿主启动词在启动钮上
 * （新建≠启动，语义分离：存预设不必起会话），本表单只保存。
 *
 * 目录选择 = tauri plugin-dialog open（thread-list.aui 同款）。禁止 innerHTML。
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { invoke } from '@tauri-apps/api/core'
import { ChevronRightIcon, XIcon } from 'lucide-react'

import { useModelCatalog, modelCatalogStore } from '@/components/assistant-ui/model-catalog-store'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'
import { useOverlayExit } from '@/lib/overlay-exit'
import { cn } from '@/lib/utils'

import { BotFace, avatarColor, botAppearance } from './bot-face'
import { botsStore, splitBotModel, useBotsStore, type BotPreset } from './bots-store'

/** hermes dialog-parts.tsx labeled() 的宿主版：label-over-control 字段对。 */
const labeled = (label: string, control: React.ReactNode) => (
  <div className="grid gap-1.5">
    <label className="text-xs font-medium text-muted-foreground">{label}</label>
    {control}
  </div>
)

/** 提交回调（launched 由 bots-pane 注入——保存后启动会话）。 */
export interface BotsDialogCallbacks {
  launched?: (bot: BotPreset) => void
}

type AdvTab = 'general' | 'skills' | 'toolsets' | 'mcp'

const ADV_TABS: { id: AdvTab; label: string }[] = [
  { id: 'general', label: '常规' },
  { id: 'skills', label: '技能' },
  { id: 'toolsets', label: '工具' },
  { id: 'mcp', label: 'MCP' },
]

/** 新建/编辑表单浮层。editing = null 新建；非 null 编辑该 bot。 */
export function BotsDialog({
  callbacks,
  editing,
  onClose,
}: {
  callbacks: BotsDialogCallbacks
  editing: BotPreset | null
  onClose: () => void
}) {
  // 表单初值 = 编辑对象或空（hermes create-dialog reset 语义）
  const [name, setName] = useState(editing?.name ?? '')
  const [title, setTitle] = useState(editing?.title ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [systemPrompt, setSystemPrompt] = useState(editing?.systemPrompt ?? '')
  const [model, setModel] = useState(editing?.model ?? '')
  const [cwd, setCwd] = useState(editing?.cwd ?? '')
  // 技能白名单（hermes profile.skills 对偶）：pi_capabilities 的已装技能
  // 真清单（name 集合），多选；启动时拼进 system prompt（bot-launch）
  const [skills, setSkills] = useState<readonly string[]>(editing?.skills ?? [])
  // 工具集白名单（hermes toolsets 页签对偶）：key 集合；启动映射 enabled_tools
  const [toolsets, setToolsets] = useState<readonly string[]>(editing?.toolsets ?? [])
  const [caps, setCaps] = useState<{
    skills: { name: string; description: string }[]
    toolsets: { key: string; label?: string; description?: string; tools: string[]; needsSetup?: boolean }[]
  }>({ skills: [], toolsets: [] })
  useEffect(() => {
    void invoke<{
      skills: { name: string; description: string }[]
      toolsets: { key: string; label?: string; description?: string; tools: string[]; needsSetup?: boolean }[]
    }>('pi_capabilities')
      .then((r) => setCaps({ skills: r.skills, toolsets: r.toolsets }))
      .catch((e) => console.error('[bots] 能力目录读取失败', e))
  }, [])
  // Advanced（hermes :842-888：折叠钮 + SegmentedControl 页签）
  const [advanced, setAdvanced] = useState(false)
  const [advTab, setAdvTab] = useState<AdvTab>('general')
  // 头像四元组（AvatarPicker 状态——hermes create-dialog :614-626 同位；
  // image = data URL，FileReader 读取，随预设落本地存储）
  const [color, setColor] = useState<null | string>(editing?.color ?? null)
  const [shape, setShape] = useState<null | string>(editing?.shape ?? null)
  const [image, setImage] = useState<null | string>(editing?.image ?? null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const appearance = botAppearance(name.trim() || 'agent', {
    color: color ?? undefined,
    shape: shape ?? '',
    image,
  })

  // 连接清单（多环境"创建在哪个连接上"——hermes create-dialog :641-671
  // Create on 连接选择；连接数 > 1 才显示，单 local 不造选择器）
  const [connections, setConnections] = useState<readonly { id: string; kind: string; label: string }[]>([])
  const [connectionId, setConnectionId] = useState(editing?.connectionId ?? 'local')
  useEffect(() => {
    void invoke<{ connections: { id: string; kind: string; label: string }[] }>(
      'pi_connections_list',
    )
      .then((r) => setConnections(r.connections))
      .catch((e) => console.error('[bots] 连接清单读取失败', e))
  }, [])

  // 模型目录（model-catalog-store：pi_list_models 共享投影；打开时拉取）
  const catalog = useModelCatalog((s) => s.entries)
  useEffect(() => {
    void modelCatalogStore.getState().load()
  }, [])

  const bots = useBotsStore((s) => s.bots)
  // taken 查重（hermes create-dialog:631-637 同语义；编辑本名不撞自己）
  const taken = useMemo(
    () => bots.some((b) => b.name === name.trim() && b.name !== editing?.name),
    [bots, name, editing],
  )
  // 模型形状校验（有值必须 provider/model——splitBotModel 的 null 边界）
  const modelInvalid = model.trim() !== '' && splitBotModel(model).provider === null
  const valid = name.trim().length > 0 && !taken && !modelInvalid

  // Escape 分层（settings-overlay 同款）
  useEffect(() => {
    const disposeEscape = pushEscapeLayer(ESCAPE_PRIORITY.overlay)
    return () => disposeEscape()
  }, [])

  // 退场编排（2026-10-18）：关闭先播 160ms 退场再真卸载；所有关闭路径
  // （遮罩点击/Esc/✕/提交后）必须走 requestClose，否则退场被跳过
  // （onClose 直连 = 同步卸载，CSS 没有机会播）。
  const { closing, requestClose } = useOverlayExit(onClose)

  const onEscape = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && isTopEscapeLayer(ESCAPE_PRIORITY.overlay)) {
      e.stopPropagation()
      requestClose()
    }
  }

  const onPickWorkspace = async () => {
    try {
      const dir = await openDialog({ directory: true })
      if (!dir || typeof dir !== 'string') return
      setCwd(dir)
    } catch (e) {
      console.error('[bots] 工作区选择失败（Tauri 对话框不可用？）', e)
    }
  }

  const submit = () => {
    if (!valid) return
    const preset: BotPreset = {
      name: name.trim(),
      title: title.trim(),
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      model: model.trim(),
      cwd: cwd.trim(),
      createdAt: editing?.createdAt ?? Date.now(),
      // 多环境归属（hermes "Create on connection"）
      connectionId: connectionId,
      // 技能白名单（hermes profile.skills——启动拼进 system prompt）
      skills: [...skills],
      // 工具集白名单（hermes toolsets——启动映射 enabled_tools）
      toolsets: [...toolsets],
      // 头像（hermes BotMeta 的 avatar 字段——custom 置位后默认外观停止套用）
      color: color ?? undefined,
      shape: shape ?? undefined,
      image,
      custom: color !== null || shape !== null || image !== null,
    }
    // Duplicate 名也可建（hermes duplicateBot 语义——upsert 按 name 键）
    botsStore.getState().upsert(preset, editing?.name)
    callbacks.launched?.(preset)
    requestClose()
  }

  return createPortal(
    <div
      className={closing ? 'set-overlay set-overlay--closing' : 'set-overlay'}
      onClick={requestClose}
      onKeyDown={onEscape}
      role="presentation"
    >
      <div
        aria-label={editing ? '编辑机器人' : '新建机器人'}
        aria-modal="true"
        className="set-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        style={{
          // hermes :737-751：平时 max-w-md（448），高级态 max-w-3xl（768）
          // + 原生缩放手势（resize:both 需 overflow:auto，minSize 兜底）。
          width: advanced ? 'min(48rem, 95vw)' : 448,
          maxWidth: '95vw',
          maxHeight: '85vh',
          height: 'auto',
          minWidth: advanced ? 420 : undefined,
          minHeight: advanced ? 360 : undefined,
          overflow: 'auto',
          display: 'block',
          ...(advanced ? { resize: 'both' as const } : {}),
        }}
      >
        {/* hermes Dialog 度量：body = grid gap-3 p-4；header gap-1；主栈
            gap-3.5（:757）；footer 右对齐 gap-2。皮肤仍用 set-card。 */}
        <div className="grid gap-3 p-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-[0.9375rem] font-semibold tracking-tight text-foreground">
              {editing ? '编辑机器人' : '新建机器人'}
            </h2>
            <p className="text-muted-foreground text-xs">
              保存 = 预设入库；启动 = 以该配置开新会话（技能拼进系统提示、工具集映射
              enabled_tools）。
            </p>
          </div>
          <div className="grid gap-3.5">
            {/* BotFace 预览（hermes :758-766：flex justify-center py-1） */}
            <div className="flex justify-center py-1">
              <BotFace
                color={avatarColor(appearance.color, name.trim() || 'agent')}
                image={appearance.image}
                name={name.trim() || 'agent'}
                shape={appearance.shape}
                size={56}
              />
            </div>
            {/* AvatarPicker 宿主版（形状行 + 颜色行 + 图片上传/还原默认） */}
            <div className="flex flex-wrap justify-center gap-1">
              {(['circle', 'squircle', 'pill', 'triangle', 'hexagon', 'cloud', 'drop'] as const).map(
                (s) => (
                  <button
                    aria-label={`形状 ${s}`}
                    className={cn(
                      'rounded-md border p-0.5 transition-colors',
                      appearance.shape === s ? 'border-(--color-brand)' : 'border-transparent hover:border-border',
                    )}
                    key={s}
                    onClick={() => setShape(s)}
                    type="button"
                  >
                    <BotFace color={avatarColor(appearance.color, name.trim() || 'agent')} name={name.trim() || 'agent'} shape={s} size={22} />
                  </button>
                ),
              )}
            </div>
            <div className="flex flex-wrap justify-center gap-1">
              {['#8b5cf6', '#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#ec4899', '#6366f1', '#64748b'].map(
                (c) => (
                  <button
                    aria-label={`颜色 ${c}`}
                    className={cn(
                      'size-5 rounded-full border-2 transition-transform',
                      color === c ? 'border-foreground scale-110' : 'border-transparent',
                    )}
                    key={c}
                    onClick={() => {
                      setColor(c)
                      setImage(null)
                    }}
                    style={{ backgroundColor: c }}
                    type="button"
                  />
                ),
              )}
              <input
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (!file) return
                  const reader = new FileReader()
                  reader.onload = () => {
                    if (typeof reader.result === 'string') setImage(reader.result)
                  }
                  reader.readAsDataURL(file)
                }}
                ref={fileInputRef}
                type="file"
              />
              <button
                className="set-btn"
                onClick={() => fileInputRef.current?.click()}
                type="button"
              >
                图片…
              </button>
              {(color !== null || shape !== null || image !== null) && (
                <button
                  className="set-btn"
                  onClick={() => {
                    setColor(null)
                    setShape(null)
                    setImage(null)
                  }}
                  type="button"
                >
                  还原默认
                </button>
              )}
            </div>
            {labeled(
              '名称',
              <input
                autoFocus
                className="set-input"
                onChange={(e) => setName(e.target.value)}
                placeholder="inbox-triage"
                value={name}
              />,
            )}
            {taken && (
              <div className="set-err">名为「{name.trim()}」的机器人已存在。</div>
            )}
            {connections.length > 1 &&
              labeled(
                '创建在连接上',
                <>
                  <select
                    className="set-select"
                    onChange={(e) => setConnectionId(e.target.value)}
                    value={connectionId}
                  >
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.label}（{c.kind}）
                      </option>
                    ))}
                  </select>
                  {connectionId !== 'local' && (
                    <div className="text-rose-600 dark:text-rose-400 text-xs" data-stub="true">
                      远端 gateway 未接通——该连接上的机器人启动为占位（标红）。
                    </div>
                  )}
                </>,
              )}
            {labeled(
              '显示名称',
              <input
                className="set-input"
                onChange={(e) => setTitle(e.target.value)}
                placeholder="收件箱分拣（空 = 用名称）"
                value={title}
              />,
            )}
            {labeled(
              '描述',
              <textarea
                className="set-textarea min-h-16"
                onChange={(e) => setDescription(e.target.value)}
                placeholder="这台机器人做什么……"
                value={description}
              />,
            )}
            {/* Advanced 折叠钮（hermes :842-858：text 钮 + DisclosureCaret） */}
            <button
              className="flex items-center gap-1 self-start text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setAdvanced((v) => !v)}
              type="button"
            >
              <ChevronRightIcon className={cn('size-3 transition-transform', advanced && 'rotate-90')} />
              高级
            </button>
            {advanced && (
              /* 展开容器（hermes :860：rounded-md border p-3 grid gap-3） */
              <div className="grid gap-3 rounded-md border border-border/70 p-3">
                {/* SegmentedControl（hermes :861-888 四页签同构） */}
                <div className="flex gap-0.5 rounded-md bg-muted/60 p-0.5">
                  {ADV_TABS.map((t) => (
                    <button
                      className={cn(
                        'flex-1 rounded px-2 py-1 text-xs transition-colors',
                        advTab === t.id
                          ? 'bg-background font-medium text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                      key={t.id}
                      onClick={() => setAdvTab(t.id)}
                      type="button"
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                {advTab === 'general' && (
                  <div className="grid gap-3.5">
                    {labeled(
                      '模型',
                      <select
                        className="set-select"
                        onChange={(e) => setModel(e.target.value)}
                        value={model}
                      >
                        <option value="">继承 pi 默认（settings.json）</option>
                        {catalog.map((m) => (
                          <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                            {m.name || m.id} — {m.provider}
                          </option>
                        ))}
                      </select>,
                    )}
                    {modelInvalid && (
                      <div className="set-err">模型形状非法（应为 provider/model）——重新选择。</div>
                    )}
                    {labeled(
                      'System prompt',
                      <textarea
                        className="set-textarea"
                        onChange={(e) => setSystemPrompt(e.target.value)}
                        placeholder="机器人的人格与行为准则（可选）——"
                        rows={4}
                        value={systemPrompt}
                      />,
                    )}
                    {labeled(
                      '工作区',
                      <div className="flex items-center gap-1.5">
                        <input
                          className="set-input"
                          onChange={(e) => setCwd(e.target.value)}
                          placeholder="进程目录（默认）"
                          readOnly
                          value={cwd}
                        />
                        <button className="set-btn" onClick={() => void onPickWorkspace()} type="button">
                          选择目录…
                        </button>
                        {cwd && (
                          <button className="set-btn" onClick={() => setCwd('')} type="button">
                            清除
                          </button>
                        )}
                      </div>,
                    )}
                  </div>
                )}
                {advTab === 'skills' && (
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-muted-foreground">
                      技能（{skills.length} 选中）
                    </label>
                    {caps.skills.length > 0 ? (
                      <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-md border border-border/60 p-1">
                        {caps.skills.map((s) => (
                          <button
                            className={cn(
                              'hover:bg-accent/60 flex items-start gap-1.5 rounded px-1.5 py-1 text-left text-xs transition-colors',
                              skills.includes(s.name) && 'bg-accent/80',
                            )}
                            key={s.name}
                            onClick={() =>
                              setSkills((prev) =>
                                prev.includes(s.name)
                                  ? prev.filter((x) => x !== s.name)
                                  : [...prev, s.name],
                              )
                            }
                            type="button"
                          >
                            <span
                              aria-hidden
                              className={cn(
                                'mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded border',
                                skills.includes(s.name)
                                  ? 'border-(--color-brand) bg-(--color-brand) text-white'
                                  : 'border-border',
                              )}
                            >
                              {skills.includes(s.name) ? '✓' : ''}
                            </span>
                            <span className="min-w-0">
                              <span className="text-foreground block font-mono text-[0.6875rem]">/{s.name}</span>
                              {s.description.trim() && (
                                <span className="text-muted-foreground block truncate">{s.description}</span>
                              )}
                            </span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="text-muted-foreground rounded-md border border-border/60 px-2 py-1.5 text-xs">
                        未安装技能——放到 <code className="font-mono">~/.pi/agent/skills/&lt;名称&gt;/SKILL.md</code> 后重新打开。
                      </div>
                    )}
                    <p className="text-muted-foreground/80 text-xs">
                      选中技能在启动时拼进该机器人的系统提示（新会话生效）。
                    </p>
                  </div>
                )}
                {advTab === 'toolsets' && (
                  <div className="grid gap-1.5">
                    <label className="text-xs font-medium text-muted-foreground">
                      工具集（{toolsets.length} 选中）
                    </label>
                    <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto rounded-md border border-border/60 p-1">
                      {caps.toolsets.map((ts) => {
                        const isChecked = toolsets.includes(ts.key)
                        return (
                          <label
                            className={cn(
                              'hover:bg-accent/60 flex min-w-0 cursor-pointer items-center gap-2 rounded px-1.5 py-1 transition-colors',
                              isChecked && 'bg-accent/80',
                            )}
                            key={ts.key}
                          >
                            <input
                              checked={isChecked}
                              className="accent-(--color-brand)"
                              onChange={(e) =>
                                setToolsets((prev) =>
                                  e.target.checked
                                    ? [...prev, ts.key]
                                    : prev.filter((x) => x !== ts.key),
                                )
                              }
                              type="checkbox"
                            />
                            <span className="min-w-0 flex-1">
                              <span className="text-foreground block truncate text-xs">
                                {ts.label || ts.key}
                                <span className="text-muted-foreground/60 ml-1.5 font-normal">
                                  {ts.tools.length} 个工具
                                </span>
                              </span>
                              {ts.description?.trim() && (
                                <span className="text-muted-foreground block truncate text-[0.625rem]">
                                  {ts.description}
                                </span>
                              )}
                              {ts.needsSetup && (
                                <span className="block text-[0.625rem] text-rose-600 dark:text-rose-400" data-stub="true">
                                  需要 pi 配置项配合才生效（memory/media/computer）
                                </span>
                              )}
                            </span>
                          </label>
                        )
                      })}
                    </div>
                    <p className="text-muted-foreground/80 text-xs">
                      选中组在启动时映射为该机器人的工具名单（enabled_tools）；不选 = pi 默认集。
                    </p>
                  </div>
                )}
                {advTab === 'mcp' && (
                  /* MCP 页（hermes McpSetupButton 对偶）：pi 无 per-bot MCP
                      装载面——红显占位，不造假配置项 */
                  <div className="grid gap-1.5" data-stub="true">
                    <label className="text-xs font-medium text-muted-foreground">MCP 服务器</label>
                    <div className="text-rose-600 dark:text-rose-400 rounded-md border border-rose-200 bg-rose-50 px-2 py-1.5 text-xs dark:border-rose-800 dark:bg-rose-950/30">
                      per-bot MCP 配置未接通（占位）——pi 无 per-session MCP 装载面。
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <button className="set-btn pressable" onClick={requestClose} type="button">
              取消
            </button>
            <button
              className="set-btn set-btn-primary pressable"
              disabled={!valid}
              onClick={submit}
              type="button"
            >
              {editing ? '保存' : '保存预设'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
