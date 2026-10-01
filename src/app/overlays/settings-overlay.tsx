/**
 * 全局设置浮层（pi-integration.md §7-7 设置页接线，分段：模型 /
 * 提供方凭据 / 压缩·compaction / 重试·retry / 高级·原始配置 / 关于）。
 * 结构化段只收录 pi Config 实锤字段——键名/类型/默认值逐项核对 vendor
 * pi_agent_rust/src/config.rs（见各段注释的行号）；Config 没有的配置面
 * （system_prompt / append_system_prompt 是 CLI/SDK 参数非 settings.json
 * 字段；工具开关的真实机制是 tools.loadMode 自由映射）不造 UI，留原始
 * JSON 段。
 *
 * 配置真相 = pi 自己的配置文件（§5）：settings.json / models.json 经
 * pi_get_settings / pi_set_models_config 管理——**nested 对象整体替换
 * 不合并（§5 上游语义），保存的永远是完整文档**。凭据状态经
 * pi_auth_status（存在性 + 已声明环境变量键名，绝不返回 key 内容）。
 * 控制面走 Tauri IPC（§4.5），不走 hermes REST seam。
 *
 * 错误即错误（工程铁律 12）：所有 invoke 失败 console.error + 段内
 * 红色错误条，不吞；JSON.parse 失败就地显示错误且保存钮禁用——不静默
 * 不保存。portal 到 body：标题栏是 z-50 的 stacking context，浮层在
 * .app-titlebar 内会被压到 veil(55)/投放(60) 之下——portal 出去后
 * z 130（overlays.css .set-overlay）才盖得住。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { XIcon } from 'lucide-react'

import pkg from '../../../package.json'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'

/** pi 模型目录条目（pi_list_models 返回形状，同 composer-wired）。 */
interface PiModelEntry {
  provider: string
  id: string
  name: string
  contextWindow: number
}

/** pi_auth_status 行——存在性与凭据类型，绝不携带 key 内容。 */
interface PiAuthRow {
  provider: string
  configured: boolean
  source: string
  credentialType: string | null
  envVar?: string
  envSet?: boolean
  envKeys?: { name: string; set: boolean }[]
}

interface PiAuthStatus {
  authPath: string
  settingsPath: string
  modelsPath: string
  authFileExists: boolean
  providers: PiAuthRow[]
}

type SettingsDoc = Record<string, unknown>

/** settings.json 默认模型键（pi Config 字段名，config.rs:44-47——
    serde 序列化写出 snake_case，camelCase 是读取别名；写文档时优先
    更新已存在的形式，避免同一键双形式并存造成 serde 顺序歧义）。 */
const DEFAULT_PROVIDER_KEYS = ['default_provider', 'defaultProvider'] as const
const DEFAULT_MODEL_KEYS = ['default_model', 'defaultModel'] as const

/** 解析配置原始文本（空文本 = 文件尚未存在，从 {} 起步）。
    label 用于错误消息（settings / models）。 */
function parseJsonDoc(text: string, label: string): { doc: SettingsDoc } | { error: string } {
  if (text.trim() === '') return { doc: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    return { error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: `${label} 文档必须是 JSON object（pi load_settings_json_object 同约束）` }
  }
  return { doc: parsed as SettingsDoc }
}

/** 文档中已存在的键形式（snake 优先），不存在则取首选项。 */
function existingKey(doc: SettingsDoc, keys: readonly string[]): string {
  return keys.find((k) => k in doc) ?? keys[0]
}

/** 当前默认模型（defaultProvider/defaultModel 任一形式都读）。 */
function readDefaultModel(doc: SettingsDoc): { provider: string; modelId: string } | null {
  const p = doc[existingKey(doc, DEFAULT_PROVIDER_KEYS)]
  const m = doc[existingKey(doc, DEFAULT_MODEL_KEYS)]
  if (typeof p === 'string' && p !== '' && typeof m === 'string' && m !== '') {
    return { provider: p, modelId: m }
  }
  return null
}

// ── 结构化段（压缩/重试）共用原语 ─────────────────────────────────────
//
// 键名实锤（vendor pi_agent_rust/src/config.rs）：Config 无 rename_all，
// serde 序列化写盘 = 字段名的 snake_case（reserve_tokens 等，config.rs:
// 359-371/380-404），camelCase 只是读取别名（#[serde(alias)]）。因此写
// 文档一律用 canonical snake_case；文档里已有别名形式则原地更新（与上方
// DEFAULT_PROVIDER_KEYS 同策略，避免同字段双形式并存——serde 对同名两键
// 取文档序靠后者，行为含混）。未设置的键 = pi 内置默认（Config 全字段
// Option，JSON null 与缺键同为 None）。

const U32_MAX = 4294967295
/** u64 字段在 JS 侧以安全整数封顶（超过即失去整数精度）。 */
const SAFE_U64_MAX = 9007199254740991

/** 压缩段键组（config.rs:359-371 CompactionSettings + 顶层
    compaction_mode，config.rs:231-234——该键无 camelCase 别名，只认
    snake_case）。 */
const K_ENABLED = ['enabled'] as const
const K_RESERVE_TOKENS = ['reserve_tokens', 'reserveTokens'] as const
const K_KEEP_RECENT_TOKENS = ['keep_recent_tokens', 'keepRecentTokens'] as const
const K_MODE = ['mode'] as const
const K_COMPACTION_MODE = ['compaction_mode'] as const

/** 重试段键组（config.rs:380-404 RetrySettings）。 */
const K_MAX_RETRIES = ['max_retries', 'maxRetries'] as const
const K_BASE_DELAY_MS = ['base_delay_ms', 'baseDelayMs'] as const
const K_MAX_DELAY_MS = ['max_delay_ms', 'maxDelayMs'] as const
const K_FAILOVER_COOLDOWN_SECS = [
  'failover_cooldown_secs',
  'failoverCooldownSecs',
  'cooldownSecs',
] as const
const K_MAX_FAILOVERS_PER_TURN = ['max_failovers_per_turn', 'maxFailoversPerTurn'] as const

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 字段读取结果：unset = 缺键/null（pi 默认生效）；ok = 文档里的原始值。 */
type FieldRead = { state: 'unset' } | { state: 'ok'; raw: unknown }

/** 读一个结构化字段（loc = 嵌套段名，null = 顶层键）。 */
function readField(
  doc: SettingsDoc,
  loc: 'compaction' | 'retry' | null,
  keys: readonly string[],
): FieldRead {
  const rec =
    loc === null ? doc : isPlainObject(doc[loc]) ? (doc[loc] as SettingsDoc) : undefined
  if (rec === undefined) return { state: 'unset' }
  const key = keys.find((k) => k in rec)
  if (key === undefined) return { state: 'unset' }
  const raw = rec[key]
  if (raw === null) return { state: 'unset' }
  return { state: 'ok', raw }
}

/** 按 [canonical, ...别名] 写/删一个键（value === undefined = 删键回默认）。 */
function applyFieldToRecord(
  rec: SettingsDoc,
  keys: readonly string[],
  value: unknown | undefined,
): void {
  const key = keys.find((k) => k in rec) ?? keys[0]
  if (value === undefined) delete rec[key]
  else rec[key] = value
}

/** 控件视图：unset（显示默认占位）/ set（文档值）/ invalid（文档里该键
    类型不符——pi 反序列化会拒绝整份文档，如实显示不兜底）。 */
type FieldView<T> =
  | { kind: 'unset' }
  | { kind: 'set'; value: T }
  | { kind: 'invalid'; raw: unknown }

function boolView(read: FieldRead): FieldView<boolean> {
  if (read.state === 'unset') return { kind: 'unset' }
  if (typeof read.raw === 'boolean') return { kind: 'set', value: read.raw }
  return { kind: 'invalid', raw: read.raw }
}

function numView(read: FieldRead): FieldView<number> {
  if (read.state === 'unset') return { kind: 'unset' }
  if (typeof read.raw === 'number' && Number.isInteger(read.raw)) {
    return { kind: 'set', value: read.raw }
  }
  return { kind: 'invalid', raw: read.raw }
}

function enumView(read: FieldRead, allowed: readonly string[]): FieldView<string> {
  if (read.state === 'unset') return { kind: 'unset' }
  if (typeof read.raw === 'string' && allowed.includes(read.raw)) {
    return { kind: 'set', value: read.raw }
  }
  return { kind: 'invalid', raw: read.raw }
}

/** 串行写入队列的一笔改动（见 SettingsOverlay 内 drainWrites）。 */
interface StructuredWriteJob {
  ui: 'compaction' | 'retry'
  loc: 'compaction' | 'retry' | null
  keys: readonly string[]
  value: unknown | undefined
  savedMsg: string
  done: () => void
}

/** 在 base 上施加一笔结构化键改动（不改 base）。段存在但不是 object →
    err（pi 侧校验也会拒绝，这里给出可读消息）；否则返回新文档。 */
function applyStructuredMutation(
  base: SettingsDoc,
  loc: 'compaction' | 'retry' | null,
  keys: readonly string[],
  value: unknown | undefined,
): { ok: SettingsDoc } | { err: string } {
  const doc: SettingsDoc = { ...base }
  if (loc === null) {
    applyFieldToRecord(doc, keys, value)
    return { ok: doc }
  }
  const existing = doc[loc]
  if (value === undefined && existing === undefined) {
    return { ok: doc } // 段不存在 = 全默认，无可删（幂等写）
  }
  if (existing !== undefined && !isPlainObject(existing)) {
    return { err: `${loc} 段不是 JSON object——先在「高级 · 原始配置」修正后再改此设置` }
  }
  const obj: SettingsDoc = isPlainObject(existing) ? { ...existing } : {}
  applyFieldToRecord(obj, keys, value)
  if (Object.keys(obj).length === 0) delete doc[loc]
  else doc[loc] = obj
  return { ok: doc }
}

/** 结构化字段行：等宽键名 + 控件列（控件下可带说明/错误）。 */
function SetField({ name, note, children }: { name: string; note?: string; children: ReactNode }) {
  return (
    <div className="set-field">
      <span className="set-field-label">{name}</span>
      <div className="set-field-control">
        {children}
        {note !== undefined && <span className="set-field-note">{note}</span>}
      </div>
    </div>
  )
}

/** 类型不符的当前值——pi 会拒绝整份文档，如实显示（禁止兜底）。 */
function SetInvalidNote({ raw, expect }: { raw: unknown; expect: string }) {
  return (
    <div className="set-err">
      当前值 {JSON.stringify(raw)} 不是{expect}——pi 会拒绝该文档；请先在「高级 · 原始配置」修正。
    </div>
  )
}

/** 三态布尔：未设置（删键，pi 默认生效）/ 启用 / 禁用。 */
function SetBoolField({ read, unsetLabel, onWrite }: {
  read: FieldRead
  unsetLabel: string
  onWrite: (value: boolean | undefined) => Promise<void>
}) {
  const view = boolView(read)
  return (
    <>
      <select
        className="set-select"
        onChange={(e) => {
          const v = e.target.value
          void onWrite(v === '' ? undefined : v === 'true')
        }}
        value={view.kind === 'set' ? (view.value ? 'true' : 'false') : ''}
      >
        <option value="">{unsetLabel}</option>
        <option value="true">启用</option>
        <option value="false">禁用</option>
      </select>
      {view.kind === 'invalid' && <SetInvalidNote expect="布尔值" raw={view.raw} />}
    </>
  )
}

/** 非负整数输入：草稿态本地保存（受控输入每击写盘 + IPC 回写会吃字），
    落盘成功或失败后回显文档值。空文本 = 删键回默认；越界/非整数 = 不写
    入，错误可见。 */
function SetNumField({ read, max, placeholder, onWrite, onReject }: {
  read: FieldRead
  max: number
  placeholder: string
  onWrite: (value: number | undefined) => Promise<void>
  onReject: (message: string) => void
}) {
  const view = numView(read)
  const committed = view.kind === 'set' ? String(view.value) : ''
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <>
      <input
        className="set-input"
        max={max}
        min={0}
        onChange={(e) => {
          const text = e.target.value
          setDraft(text)
          if (text.trim() === '') {
            void onWrite(undefined).then(() => setDraft(null))
            return
          }
          const n = Number(text)
          if (!Number.isInteger(n) || n < 0 || n > max) {
            onReject(`「${text}」须为 0–${max} 的整数，未写入`)
            return
          }
          void onWrite(n).then(() => setDraft(null))
        }}
        placeholder={placeholder}
        step={1}
        type="number"
        value={draft ?? committed}
      />
      {view.kind === 'invalid' && <SetInvalidNote expect="整数" raw={view.raw} />}
    </>
  )
}

/** 枚举选择：未设置（删键回默认）/ 已知取值。 */
function SetEnumField({ read, options, unsetLabel, onWrite }: {
  read: FieldRead
  options: { label: string; value: string }[]
  unsetLabel: string
  onWrite: (value: string | undefined) => Promise<void>
}) {
  const view = enumView(
    read,
    options.map((o) => o.value),
  )
  return (
    <>
      <select
        className="set-select"
        onChange={(e) => {
          const v = e.target.value
          void onWrite(v === '' ? undefined : v)
        }}
        value={view.kind === 'set' ? view.value : ''}
      >
        <option value="">{unsetLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {view.kind === 'invalid' && <SetInvalidNote expect="已知枚举值" raw={view.raw} />}
    </>
  )
}

export function SettingsOverlay({ onClose }: { onClose: () => void }) {
  // Esc 关闭（escape-layers overlay 层=40）：拖拽层（50）在拖拽中更高，
  // Esc 只中止拖拽不关浮层；编辑模式（20）更低，浮层开着时 Esc 不退编辑模式。
  useEffect(() => {
    const release = pushEscapeLayer(ESCAPE_PRIORITY.overlay)
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (e.defaultPrevented) return
      if (!isTopEscapeLayer(ESCAPE_PRIORITY.overlay)) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      release()
    }
  }, [onClose])

  // ── 数据面：挂载即拉取（§4.5 IPC）；null = 载入中（可见状态）──
  const [models, setModels] = useState<PiModelEntry[] | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [auth, setAuth] = useState<PiAuthStatus | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [settingsText, setSettingsText] = useState<string | null>(null)
  const [settingsMissing, setSettingsMissing] = useState(false)
  const [settingsError, setSettingsError] = useState<string | null>(null)
  const [modelsConfigText, setModelsConfigText] = useState<string | null>(null)
  const [modelsConfigMissing, setModelsConfigMissing] = useState(false)
  const [modelsConfigError, setModelsConfigError] = useState<string | null>(null)
  // 保存成功反馈（可见；任一文本改动即清除——陈旧的"已保存"= 假装成功）
  const [settingsSaved, setSettingsSaved] = useState<string | null>(null)
  const [modelsConfigSaved, setModelsConfigSaved] = useState<string | null>(null)
  const [modelSaved, setModelSaved] = useState<string | null>(null)
  const [compactionSaved, setCompactionSaved] = useState<string | null>(null)
  const [compactionError, setCompactionError] = useState<string | null>(null)
  const [retrySaved, setRetrySaved] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)
  // 结构化段写入队列（见 drainWrites）：settingsTextRef = 渲染期同步的
  // 最新已提交文本；writesRef.committed = 最后一笔成功落盘的完整文档。
  const settingsTextRef = useRef<string | null>(null)
  settingsTextRef.current = settingsText
  const writesRef = useRef<{
    queue: StructuredWriteJob[]
    committed: SettingsDoc | null
    running: boolean
  }>({ queue: [], committed: null, running: false })

  /** 结构化段写入泵：每次改动 = 一笔完整文档写盘。快速连续改动（数字
      输入逐键、连点下拉）逐笔入队，每笔都基于「上一笔成功落盘的文档」
      重新施加自己的键改动——Tauri async 命令不保证落盘顺序，直接并发
      invoke 会互相覆盖（丢失更新）。失败路径（原始文档解析失败 / 高级段
      有未保存手改 / 段形状不符 / invoke Err）一律段内错误条可见，不静默。 */
  const drainWrites = useCallback(() => {
    const w = writesRef.current
    if (w.running || w.queue.length === 0) return
    w.running = true

    const failJob = (job: StructuredWriteJob, msg: string) => {
      if (job.ui === 'retry') {
        setRetrySaved(null)
        setRetryError(msg)
      } else {
        setCompactionSaved(null)
        setCompactionError(msg)
      }
    }

    const step = (): void => {
      const cur = writesRef.current
      const job = cur.queue[0]
      if (job === undefined) {
        cur.running = false
        return
      }
      // 基准文档：首笔 = 当前 settings 文本（保留高级段未保存的手改）；
      // 后续 = 上一笔成功落盘的文档。原始文本与落盘文档内容不一致
      // （高级段有未保存手改）→ 拒绝并可见报错，不得静默覆盖用户编辑。
      let base: SettingsDoc
      const parsed = parseJsonDoc(settingsTextRef.current ?? '', 'settings')
      if ('error' in parsed) {
        failJob(
          job,
          `settings 文档解析失败，未写入——先在「高级 · 原始配置」修正 JSON：${parsed.error}`,
        )
        cur.queue.shift()
        job.done()
        void Promise.resolve().then(step)
        return
      }
      if (cur.committed === null) {
        base = parsed.doc
      } else if (JSON.stringify(parsed.doc) !== JSON.stringify(cur.committed)) {
        failJob(job, '「高级 · 原始配置」有未保存的手动编辑——先保存或还原该段，再改此设置')
        cur.queue.shift()
        job.done()
        void Promise.resolve().then(step)
        return
      } else {
        base = { ...cur.committed }
      }
      const applied = applyStructuredMutation(base, job.loc, job.keys, job.value)
      if ('err' in applied) {
        failJob(job, applied.err)
        cur.queue.shift()
        job.done()
        void Promise.resolve().then(step)
        return
      }
      void invoke('pi_set_settings', { value: applied.ok })
        .then(() => {
          writesRef.current.committed = applied.ok
          setSettingsText(JSON.stringify(applied.ok, null, 2))
          setSettingsMissing(false)
          setSettingsError(null)
          // 文档被整体替换——其它段的“已保存”徽标按陈旧处理
          setSettingsSaved(null)
          setModelSaved(null)
          setCompactionSaved(null)
          setRetrySaved(null)
          if (job.ui === 'retry') {
            setRetrySaved(job.savedMsg)
            setRetryError(null)
          } else {
            setCompactionSaved(job.savedMsg)
            setCompactionError(null)
          }
        })
        .catch((e: unknown) => {
          console.error('[pi] settings.json 写入失败（结构化段）', e)
          failJob(job, String(e))
        })
        .finally(() => {
          writesRef.current.queue.shift()
          job.done()
          void Promise.resolve().then(step)
        })
    }
    step()
  }, [])

  /** 入队一笔结构化写入。promise 永不 reject——失败已经段内错误条上屏，
      resolve（成功或失败）供控件复位草稿态。 */
  const enqueueStructuredWrite = useCallback(
    (
      ui: 'compaction' | 'retry',
      loc: 'compaction' | 'retry' | null,
      keys: readonly string[],
      value: unknown | undefined,
      savedMsg: string,
    ): Promise<void> =>
      new Promise<void>((resolve) => {
        writesRef.current.queue.push({ ui, loc, keys, value, savedMsg, done: resolve })
        drainWrites()
      }),
    [drainWrites],
  )

  const writeCompactionKey = useCallback(
    (keys: readonly string[], value: unknown | undefined): Promise<void> =>
      enqueueStructuredWrite('compaction', 'compaction', keys, value, '已写入 settings.json'),
    [enqueueStructuredWrite],
  )

  const writeRetryKey = useCallback(
    (keys: readonly string[], value: unknown | undefined): Promise<void> =>
      enqueueStructuredWrite('retry', 'retry', keys, value, '已写入 settings.json'),
    [enqueueStructuredWrite],
  )

  /** compaction_mode 是顶层键（config.rs:231-234，无别名，只认 snake_case），
      反馈落在压缩段。 */
  const writeCompactionMode = useCallback(
    (value: unknown | undefined): Promise<void> =>
      enqueueStructuredWrite('compaction', null, K_COMPACTION_MODE, value, '已写入 settings.json'),
    [enqueueStructuredWrite],
  )

  const rejectNum = useCallback((ui: 'compaction' | 'retry', msg: string) => {
    if (ui === 'retry') {
      setRetrySaved(null)
      setRetryError(msg)
    } else {
      setCompactionSaved(null)
      setCompactionError(msg)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await invoke<{ models: PiModelEntry[] }>('pi_list_models')
        if (!cancelled) setModels(res.models ?? [])
      } catch (e) {
        console.error('[pi] 模型目录获取失败', e)
        if (!cancelled) setModelsError(String(e))
      }
    })()
    void (async () => {
      try {
        const res = await invoke<PiAuthStatus>('pi_auth_status')
        if (!cancelled) setAuth(res)
      } catch (e) {
        console.error('[pi] 凭据状态获取失败', e)
        if (!cancelled) setAuthError(String(e))
      }
    })()
    void (async () => {
      try {
        const doc = await invoke<SettingsDoc | null>('pi_get_settings')
        if (!cancelled) {
          setSettingsText(doc ? JSON.stringify(doc, null, 2) : '')
          setSettingsMissing(doc === null)
        }
      } catch (e) {
        console.error('[pi] settings.json 读取失败', e)
        if (!cancelled) setSettingsError(String(e))
      }
    })()
    void (async () => {
      try {
        const doc = await invoke<SettingsDoc | null>('pi_get_models_config')
        if (!cancelled) {
          setModelsConfigText(doc ? JSON.stringify(doc, null, 2) : '')
          setModelsConfigMissing(doc === null)
        }
      } catch (e) {
        console.error('[pi] models.json 读取失败', e)
        if (!cancelled) setModelsConfigError(String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // settings 文档解析（模型段取默认值 + 高级段实时错误共用一份结果）
  const settingsParsed = useMemo(
    () => (settingsText === null ? null : parseJsonDoc(settingsText, 'settings')),
    [settingsText],
  )
  const modelsConfigParsed = useMemo(
    () => (modelsConfigText === null ? null : parseJsonDoc(modelsConfigText, 'models')),
    [modelsConfigText],
  )
  const defaultModel = useMemo(() => {
    if (!settingsParsed || 'error' in settingsParsed) return null
    return readDefaultModel(settingsParsed.doc)
  }, [settingsParsed])

  /** 默认模型选择 → 写 settings.json（整体替换：parse 当前文档 → 改键 →
      送完整文档）。默认键写 pi 的 canonical 形式 default_provider/
      default_model；文档已有 camelCase 形式则原地更新。 */
  const onDefaultModelChange = useCallback(
    (value: string) => {
      if (settingsText === null || settingsParsed === null) return
      if ('error' in settingsParsed) {
        // 解析失败的文档不得被整体替换覆盖（会把用户的坏文档合法化）
        setModelSaved(null)
        return
      }
      const idx = value.indexOf('/')
      if (idx <= 0) return
      const provider = value.slice(0, idx)
      const modelId = value.slice(idx + 1)
      const doc: SettingsDoc = { ...settingsParsed.doc }
      doc[existingKey(doc, DEFAULT_PROVIDER_KEYS)] = provider
      doc[existingKey(doc, DEFAULT_MODEL_KEYS)] = modelId
      void invoke('pi_set_settings', { value: doc })
        .then(() => {
          writesRef.current.committed = doc
          setSettingsText(JSON.stringify(doc, null, 2))
          setSettingsMissing(false)
          setSettingsError(null)
          setModelSaved('默认模型已写入 settings.json（pi 创建新会话时读取）')
          setCompactionSaved(null)
          setRetrySaved(null)
        })
        .catch((e) => {
          console.error('[pi] 默认模型写入失败', e)
          setSettingsError(String(e))
          setModelSaved(null)
        })
    },
    [settingsText, settingsParsed],
  )

  /** 高级段保存：JSON.parse 失败就地显示错误且不发 invoke（禁止静默）。 */
  const saveSettingsDoc = useCallback(() => {
    if (settingsText === null || settingsParsed === null) return
    if ('error' in settingsParsed) {
      setSettingsError(`未保存：${settingsParsed.error}`)
      return
    }
    void invoke('pi_set_settings', { value: settingsParsed.doc })
      .then(() => {
        writesRef.current.committed = settingsParsed.doc
        setSettingsError(null)
        setSettingsSaved('已保存到 settings.json')
      })
      .catch((e) => {
        console.error('[pi] settings.json 写入失败', e)
        setSettingsError(String(e))
        setSettingsSaved(null)
      })
  }, [settingsText, settingsParsed])

  const saveModelsConfigDoc = useCallback(() => {
    if (modelsConfigText === null || modelsConfigParsed === null) return
    if ('error' in modelsConfigParsed) {
      setModelsConfigError(`未保存：${modelsConfigParsed.error}`)
      return
    }
    void invoke('pi_set_models_config', { value: modelsConfigParsed.doc })
      .then(() => {
        setModelsConfigError(null)
        setModelsConfigMissing(false)
        setModelsConfigSaved('已保存到 models.json')
      })
      .catch((e) => {
        console.error('[pi] models.json 写入失败', e)
        setModelsConfigError(String(e))
        setModelsConfigSaved(null)
      })
  }, [modelsConfigText, modelsConfigParsed])

  const refreshAuth = useCallback(() => {
    void invoke<PiAuthStatus>('pi_auth_status')
      .then((res) => {
        setAuth(res)
        setAuthError(null)
      })
      .catch((e) => {
        console.error('[pi] 凭据状态获取失败', e)
        setAuthError(String(e))
      })
  }, [])

  const settingsParseError = settingsParsed !== null && 'error' in settingsParsed
    ? settingsParsed.error
    : null

  return createPortal(
    <div className="set-overlay" onClick={onClose} role="presentation">
      <div
        aria-label="设置"
        aria-modal="true"
        className="set-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="set-header">
          <h2 className="set-title">设置</h2>
          <button aria-label="关闭设置" className="set-close" onClick={onClose} type="button">
            <XIcon size={14} />
          </button>
        </div>
        <div className="set-body">
          {/* ── 模型：pi_list_models 目录 + 默认模型写 settings ── */}
          <section className="set-section">
            <span className="set-label">模型</span>
            {modelsError !== null && <div className="set-err">{modelsError}</div>}
            {models === null && modelsError === null && (
              <span className="set-file-missing">加载中…</span>
            )}
            {models !== null && (
              <>
                <select
                  className="set-select"
                  onChange={(e) => onDefaultModelChange(e.target.value)}
                  value={defaultModel ? `${defaultModel.provider}/${defaultModel.modelId}` : ''}
                >
                  <option disabled value="">
                    未设置（pi 使用内置默认）
                  </option>
                  {models.map((m) => (
                    <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                      {m.name || m.id} — {m.provider} · {m.contextWindow.toLocaleString()} tokens
                    </option>
                  ))}
                </select>
                <p className="set-hint">
                  默认模型写入 settings.json 的{' '}
                  <span className="set-code">default_provider</span> /{' '}
                  <span className="set-code">default_model</span>（pi 创建新会话时读取；
                  对当前会话用输入框的模型选择器切换）。
                </p>
                {settingsParseError !== null && (
                  <div className="set-err">
                    settings 文档解析失败——修正「原始配置」里的 JSON 后再选默认模型：{settingsParseError}
                  </div>
                )}
                {modelSaved !== null && <span className="set-saved">{modelSaved}</span>}
              </>
            )}
          </section>

          {/* ── 提供方凭据：pi_auth_status 状态列表 ── */}
          <section className="set-section">
            <span className="set-label">提供方凭据</span>
            {authError !== null && <div className="set-err">{authError}</div>}
            {auth === null && authError === null && (
              <span className="set-file-missing">加载中…</span>
            )}
            {auth !== null && (
              <>
                <p className="set-hint">
                  凭据存在性来自 pi 的 auth.json 与 models.json（只报存在性与类型，绝不显示 key 内容）。
                  {auth.authFileExists ? '' : ' auth.json 尚不存在。'}
                  {auth.providers.length === 0
                    ? ' 配 key 的方式（pi 语义）：① 环境变量——内置提供方读取各自声明的变量（如 ANTHROPIC_API_KEY、OPENAI_API_KEY、GOOGLE_API_KEY）；② models.json 的 apiKey 支持 !命令（shell 查找）、env:VAR、file:路径、裸大写环境变量名或字面量；③ pi 登录流程（OAuth）写入 auth.json。'
                    : ''}
                </p>
                {auth.providers.length > 0 && (
                  <div className="set-rows">
                    {auth.providers.map((row) => (
                      <div className="set-row" key={row.provider}>
                        <span className="set-row-provider">{row.provider}</span>
                        {row.configured ? (
                          <span className="set-row-ok">已配置 ✓</span>
                        ) : (
                          <span className="set-row-miss">未配置</span>
                        )}
                        <span className="set-row-source">
                          {row.source === 'auth'
                            ? `auth.json · ${row.credentialType ?? 'unknown'}`
                            : row.source === 'models'
                              ? `models.json · ${row.credentialType ?? '无凭据引用'}`
                              : row.source}
                        </span>
                        {row.envVar !== undefined && (
                          <span className={`set-row-env${row.envSet ? '' : ' set-row-env-off'}`}>
                            {row.envVar}（{row.envSet ? '已设置' : '未设置'}）
                          </span>
                        )}
                        {row.envKeys?.map((k) => (
                          <span
                            className={`set-row-env${k.set ? '' : ' set-row-env-off'}`}
                            key={k.name}
                          >
                            {k.name}（{k.set ? '已设置' : '未设置'}）
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
                <div className="set-actions">
                  <button className="set-btn" onClick={refreshAuth} type="button">
                    刷新
                  </button>
                </div>
              </>
            )}
          </section>

          {/* ── 压缩：compaction 结构化段（vendor config.rs:359-371
              CompactionSettings + 顶层 compaction_mode，config.rs:231-234/
              1085-1089；枚举值见 compaction.rs 的 serde 表示）——开关/
              数字/枚举，逐笔组装完整文档整体写回 ── */}
          <section className="set-section">
            <span className="set-label">压缩 · Compaction</span>
            <p className="set-hint">
              上下文逼近模型上限时 pi 自动压缩历史。改动写入 settings.json 的{' '}
              <span className="set-code">compaction</span> 对象与顶层{' '}
              <span className="set-code">compaction_mode</span>；未设置的键 = pi
              内置默认（enabled 启用、reserve_tokens 16384、
              keep_recent_tokens 20000、mode text、compaction_mode summary）。
            </p>
            {settingsMissing && (
              <span className="set-file-missing">settings.json 尚不存在——首次保存将创建</span>
            )}
            {compactionError !== null && <div className="set-err">{compactionError}</div>}
            {settingsText === null ? (
              settingsError === null ? (
                <span className="set-file-missing">加载中…</span>
              ) : (
                <div className="set-err">{settingsError}</div>
              )
            ) : settingsParsed !== null && !('error' in settingsParsed) ? (
              <>
                <SetField name="enabled">
                  <SetBoolField
                    onWrite={(v) => writeCompactionKey(K_ENABLED, v)}
                    read={readField(settingsParsed.doc, 'compaction', K_ENABLED)}
                    unsetLabel="未设置（默认：启用）"
                  />
                </SetField>
                <SetField name="reserve_tokens" note="压缩前预留的空间（tokens）">
                  <SetNumField
                    max={U32_MAX}
                    onReject={(msg) => rejectNum('compaction', msg)}
                    onWrite={(v) => writeCompactionKey(K_RESERVE_TOKENS, v)}
                    placeholder="默认 16384"
                    read={readField(settingsParsed.doc, 'compaction', K_RESERVE_TOKENS)}
                  />
                </SetField>
                <SetField name="keep_recent_tokens" note="压缩时保留的近期对话（tokens）">
                  <SetNumField
                    max={U32_MAX}
                    onReject={(msg) => rejectNum('compaction', msg)}
                    onWrite={(v) => writeCompactionKey(K_KEEP_RECENT_TOKENS, v)}
                    placeholder="默认 20000"
                    read={readField(settingsParsed.doc, 'compaction', K_KEEP_RECENT_TOKENS)}
                  />
                </SetField>
                <SetField name="mode" note="压缩输出的渲染方式">
                  <SetEnumField
                    onWrite={(v) => writeCompactionKey(K_MODE, v)}
                    options={[
                      { value: 'text', label: 'text（纯文本摘要）' },
                      { value: 'snapcompact', label: 'snapcompact（紧凑快照）' },
                    ]}
                    read={readField(settingsParsed.doc, 'compaction', K_MODE)}
                    unsetLabel="未设置（默认：text）"
                  />
                </SetField>
                <SetField
                  name="compaction_mode"
                  note="自动压缩策略（顶层键，非 compaction 对象内）：summary = LLM 摘要；shake-first = 先无 LLM 收缩、仍超阈值才摘要；aggressive = 摘要且减半保留窗"
                >
                  <SetEnumField
                    onWrite={writeCompactionMode}
                    options={[
                      { value: 'summary', label: 'summary（LLM 摘要）' },
                      { value: 'shake-first', label: 'shake-first（先收缩）' },
                      { value: 'aggressive', label: 'aggressive（减半保留窗）' },
                    ]}
                    read={readField(settingsParsed.doc, null, K_COMPACTION_MODE)}
                    unsetLabel="未设置（默认：summary）"
                  />
                </SetField>
              </>
            ) : (
              settingsParseError !== null && (
                <div className="set-err">
                  settings 文档解析失败——修正「高级 · 原始配置」里的 JSON 后才能使用此段：
                  {settingsParseError}
                </div>
              )
            )}
            {compactionSaved !== null && <span className="set-saved">{compactionSaved}</span>}
          </section>

          {/* ── 重试：retry 结构化段（vendor config.rs:380-404 RetrySettings；
              默认值取自 config.rs 访问器 997-1011/1112-1132）── */}
          <section className="set-section">
            <span className="set-label">重试 · Retry</span>
            <p className="set-hint">
              提供方请求瞬时失败（429/配额/过载）的自动重试。改动写入 settings.json
              的 <span className="set-code">retry</span> 对象；未设置的键 = pi
              内置默认（enabled 启用、max_retries 3、base_delay_ms 2000、
              max_delay_ms 60000）。fallback_chains（跨模型故障转移链）等富结构
              用「高级 · 原始配置」编辑。
            </p>
            {settingsMissing && (
              <span className="set-file-missing">settings.json 尚不存在——首次保存将创建</span>
            )}
            {retryError !== null && <div className="set-err">{retryError}</div>}
            {settingsText === null ? (
              settingsError === null ? (
                <span className="set-file-missing">加载中…</span>
              ) : (
                <div className="set-err">{settingsError}</div>
              )
            ) : settingsParsed !== null && !('error' in settingsParsed) ? (
              <>
                <SetField name="enabled">
                  <SetBoolField
                    onWrite={(v) => writeRetryKey(K_ENABLED, v)}
                    read={readField(settingsParsed.doc, 'retry', K_ENABLED)}
                    unsetLabel="未设置（默认：启用）"
                  />
                </SetField>
                <SetField name="max_retries" note="重试次数上限">
                  <SetNumField
                    max={U32_MAX}
                    onReject={(msg) => rejectNum('retry', msg)}
                    onWrite={(v) => writeRetryKey(K_MAX_RETRIES, v)}
                    placeholder="默认 3"
                    read={readField(settingsParsed.doc, 'retry', K_MAX_RETRIES)}
                  />
                </SetField>
                <SetField name="base_delay_ms" note="退避基数（毫秒）">
                  <SetNumField
                    max={U32_MAX}
                    onReject={(msg) => rejectNum('retry', msg)}
                    onWrite={(v) => writeRetryKey(K_BASE_DELAY_MS, v)}
                    placeholder="默认 2000"
                    read={readField(settingsParsed.doc, 'retry', K_BASE_DELAY_MS)}
                  />
                </SetField>
                <SetField name="max_delay_ms" note="退避上限（毫秒）">
                  <SetNumField
                    max={U32_MAX}
                    onReject={(msg) => rejectNum('retry', msg)}
                    onWrite={(v) => writeRetryKey(K_MAX_DELAY_MS, v)}
                    placeholder="默认 60000"
                    read={readField(settingsParsed.doc, 'retry', K_MAX_DELAY_MS)}
                  />
                </SetField>
                <SetField name="failover_cooldown_secs" note="故障转移后回切主模型前的冷却秒数">
                  <SetNumField
                    max={SAFE_U64_MAX}
                    onReject={(msg) => rejectNum('retry', msg)}
                    onWrite={(v) => writeRetryKey(K_FAILOVER_COOLDOWN_SECS, v)}
                    placeholder="默认 300"
                    read={readField(settingsParsed.doc, 'retry', K_FAILOVER_COOLDOWN_SECS)}
                  />
                </SetField>
                <SetField
                  name="max_failovers_per_turn"
                  note="单轮最多故障转移次数（pi 运行期按 8 封顶）"
                >
                  <SetNumField
                    max={U32_MAX}
                    onReject={(msg) => rejectNum('retry', msg)}
                    onWrite={(v) => writeRetryKey(K_MAX_FAILOVERS_PER_TURN, v)}
                    placeholder="默认 8"
                    read={readField(settingsParsed.doc, 'retry', K_MAX_FAILOVERS_PER_TURN)}
                  />
                </SetField>
              </>
            ) : (
              settingsParseError !== null && (
                <div className="set-err">
                  settings 文档解析失败——修正「高级 · 原始配置」里的 JSON 后才能使用此段：
                  {settingsParseError}
                </div>
              )
            )}
            {retrySaved !== null && <span className="set-saved">{retrySaved}</span>}
          </section>

          {/* ── 高级：原始配置（settings.json / models.json 整体替换）── */}
          <section className="set-section">
            <span className="set-label">高级 · 原始配置</span>
            <p className="set-hint">
              完整文档编辑，保存 = 整体替换写入（pi 语义：nested 对象不合并）。写入前经 pi
              自身 schema 校验，类型不符会被拒绝。
            </p>

            <span className="set-file-missing">
              settings.json{settingsMissing ? '（文件尚不存在——保存将创建）' : ''}
            </span>
            {settingsError !== null && <div className="set-err">{settingsError}</div>}
            {settingsText === null ? (
              settingsError === null && <span className="set-file-missing">加载中…</span>
            ) : (
              <>
                <textarea
                  aria-label="settings.json 原始配置"
                  className="set-textarea"
                  onChange={(e) => {
                    setSettingsText(e.target.value)
                    setSettingsSaved(null)
                    setModelSaved(null)
                    setCompactionSaved(null)
                    setCompactionError(null)
                    setRetrySaved(null)
                    setRetryError(null)
                  }}
                  spellCheck={false}
                  value={settingsText}
                />
                {settingsParseError !== null && (
                  <div className="set-err">{settingsParseError}</div>
                )}
                <div className="set-actions">
                  <button
                    className="set-btn set-btn-primary"
                    disabled={settingsParseError !== null}
                    onClick={saveSettingsDoc}
                    type="button"
                  >
                    保存 settings.json
                  </button>
                  {settingsSaved !== null && <span className="set-saved">{settingsSaved}</span>}
                </div>
              </>
            )}

            <span className="set-file-missing">
              models.json{modelsConfigMissing ? '（文件尚不存在——保存将创建）' : ''}
            </span>
            {modelsConfigError !== null && <div className="set-err">{modelsConfigError}</div>}
            {modelsConfigText === null ? (
              modelsConfigError === null && <span className="set-file-missing">加载中…</span>
            ) : (
              <>
                <textarea
                  aria-label="models.json 原始配置"
                  className="set-textarea"
                  onChange={(e) => {
                    setModelsConfigText(e.target.value)
                    setModelsConfigSaved(null)
                  }}
                  spellCheck={false}
                  value={modelsConfigText}
                />
                {modelsConfigParsed !== null && 'error' in modelsConfigParsed && (
                  <div className="set-err">{modelsConfigParsed.error}</div>
                )}
                <div className="set-actions">
                  <button
                    className="set-btn set-btn-primary"
                    disabled={modelsConfigParsed !== null && 'error' in modelsConfigParsed}
                    onClick={saveModelsConfigDoc}
                    type="button"
                  >
                    保存 models.json
                  </button>
                  {modelsConfigSaved !== null && (
                    <span className="set-saved">{modelsConfigSaved}</span>
                  )}
                </div>
              </>
            )}
          </section>

          {/* ── 关于：应用名/版本（package.json 构建期真值）+ 配置文件路径 ── */}
          <section className="set-section">
            <span className="set-label">关于</span>
            <dl className="set-about-defs">
              <dt>应用名</dt>
              <dd>
                {pkg.productName}（{pkg.name}）
              </dd>
              <dt>版本</dt>
              <dd>{pkg.version}</dd>
              {auth !== null && (
                <>
                  <dt>settings</dt>
                  <dd className="set-row-env">{auth.settingsPath}</dd>
                  <dt>models</dt>
                  <dd className="set-row-env">{auth.modelsPath}</dd>
                  <dt>auth</dt>
                  <dd className="set-row-env">{auth.authPath}</dd>
                </>
              )}
            </dl>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}
