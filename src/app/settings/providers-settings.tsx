/**
 * providers-settings —— hermes「提供方」设置页的移植（2026-10-23）。
 *
 * 源（hermes apps/desktop/src/app/settings/）：
 *   providers-settings.tsx (638) · custom-endpoints-settings.tsx (530) ·
 *   credential-key-ui.tsx (411) · env-credentials.tsx (218) · model-select.tsx (148)
 *
 * 子视图同构：账号（OAuth）→ API 密钥 → 自定义端点。第四个子项「本地模型」
 * 在 hermes 由 --local 启动旗标门控、默认不随包——按上游语义同样不注册
 * 'local' 视图（PROVIDER_VIEWS 只有三项）；将来接本地模型时从这里扩展。
 *
 * ── 数据面映射（hermes REST 网关 → 本宿主 Tauri IPC）─────────────────
 *
 *   hermes                                本宿主
 *   GET    /api/env                    →  invoke('pi_auth_status')
 *   PUT    /api/env                    →  invoke('pi_set_provider_key', {provider, key})
 *   DELETE /api/env                    →  invoke('pi_delete_provider_key', {provider})
 *   GET    /api/providers/oauth        →  pi_auth_status 里 source==='auth' 且
 *                                         credentialType==='oauth' 的行
 *   GET/POST /api/providers/custom-endpoints →
 *                                         invoke('pi_get_models_config' /
 *                                                'pi_set_models_config')（providers 表）
 *   activate / make_default            →  pi_get_settings 改 default_provider /
 *                                         default_model 后 pi_set_settings
 *   POST   /api/providers/custom-endpoints/validate →
 *                                         invoke('pi_endpoint_validate', {baseUrl, apiKey})
 *   model catalog                       →  invoke('pi_list_models')
 *
 * ── 数据面缺口（诚实呈现，禁止兜底/假装成功——铁律 12）────────────────
 *
 * · 密钥只写不读：pi 凭据没有 reveal 通道——hermes 的「显示值」按钮整体
 *   省略；已配置的输入框只显示「覆盖现有密钥」占位，绝不回显内容。
 * · OAuth 登录流（rpi 迁移降级）：rpi-cli 的 auth.rs 是交互式 TUI 流程，
 *   无嵌入库 API——pi_oauth_* 目前返回空清单/Err，凭据走 env key 或
 *   models.json apiKey（设置页凭据写入已覆盖）。rpi 暴露嵌入式 OAuth
 *   后接回（旧 pi 实现存档 git df701a4）。
 * · 端点测试（2026-11-14 接真）：pi_endpoint_validate 用宿主 reqwest
 *   GET {base}/models，200 且解出模型表 = ok；非 200 / 网络失败如实显示。
 * · API 模式（2026-11-14 接真）：写 provider 条目的 `api` 字段——rpi 没有
 *   协议自动检测（缺省 = anthropic-messages，openai-completions /
 *   openai-responses 必须显式），控制器可点选并持久化。
 * · 发现模型（2026-11-14 接真）：rpi 自身不发现（models[] 必须显式列出），
 *   但 OpenAI 兼容端点的 GET {base}/models 就是标准发现面——保存时勾选
 *   「发现模型」会先探测并把全量 id 写进 provider.models（按 id 保留既有
 *   逐模型配置）；探测失败错误可见并中止保存（不静默退化单模型）。
 * · hermes EnvVarInfo 的 category/description/url/redacted_value/advanced/
 *   provider_profiles/channel_managed 字段 pi_auth_status 没有：所有行按
 *   provider 域全列（等价 hermes category==='provider' 的过滤结果），
 *   channel_managed 过滤略去，描述/文档链接展开卡略去（无数据）。
 * · hermes 的 profile 域（SettingsProfileScope）与 ?pview= 深链高亮：
 *   本宿主无 profile 概念，略去。
 * · onboarding OAuth 流（$desktopOnboarding 驱动的登录弹层）：本宿主没有
 *   onboarding 面——账号视图只列状态。
 *
 * ── 交互偏差（各有就地注释）──────────────────────────────────────────
 *
 * · hermes 的 confirm() 对话框宿主没有对应原语（且 WebView2 对 window.confirm
 *   的可用性不保证——按钮静默无效就是撒谎的 UI）：断开/清除/删除直接执行，
 *   失败走内联错误条可见（与 settings-overlay 既有「清除」一致）。
 * · 端点表单的「名称」字段并入「提供商 ID」：pi 的 providers 表以 id 为键、
 *   条目没有 name 字段（任务映射：id = provider key，name = id）。
 * · 编辑时提供商 ID 输入框禁用：id 是存储键，改名 = 另建新条目而不是改名。
 *
 * 文案来源：hermes i18n zh.ts（简体 settings.segments，与 zh-hant 同文），
 * 硬编码——本宿主设置页不做 i18n。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { invoke } from '@tauri-apps/api/core'

import { inTauri } from '@/lib/tauri-window'

// ── 数据面类型（pi IPC 返回形状）────────────────────────────────────

/** pi_auth_status 行（src-tauri/src/pi_settings.rs）：存在性与凭据类型，
    绝不携带 key 内容。hermes EnvVarInfo 的扩展字段这里没有——见文件头。 */
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

/** pi 模型目录条目（pi_list_models 返回形状，同 settings-overlay）。 */
interface PiModelEntry {
  provider: string
  id: string
  name: string
  contextWindow: number
}

/** 任意 JSON object（models.json / settings.json 原始文档与条目都用它，
    字段访问处再窄化——不用 any）。 */
type JsonRecord = Record<string, unknown>

// ── 小工具 ──────────────────────────────────────────────────────────

function isJsonRecord(v: unknown): v is JsonRecord {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** IPC 失败归一成用户能看懂的话（同 settings-overlay 的 describeIpcError，
    那边未导出所以本地复制一份：只翻译不吞错——原始错误仍由各调用点的
    console.error 打出，铁律 12）。 */
function describeIpcError(e: unknown): string {
  if (!inTauri) {
    return '浏览器直开模式：没有桌面宿主后端，设置项不可读写（打包后的桌面应用里可用）'
  }
  return e instanceof Error ? e.message : String(e)
}

/** settings.json 默认模型键（**rpi 只认 camelCase**——rpi-cli Settings
    `#[serde(rename_all = "camelCase")]` 且无 snake_case alias；snake_case
    是旧 pi 时代遗留文档，双读只为兼容历史文件。写文档优先更新已存在的
    形式，避免同键双形式并存，与 settings-overlay 的同名常量同策略；
    新建键时取首选项 = camelCase）。 */
const DEFAULT_PROVIDER_KEYS = ['defaultProvider', 'default_provider'] as const
const DEFAULT_MODEL_KEYS = ['defaultModel', 'default_model'] as const

/** 文档中已存在的键形式（snake 优先），不存在则取首选项。 */
function existingKeyForm(doc: JsonRecord, keys: readonly string[]): string {
  return keys.find((k) => k in doc) ?? keys[0]
}

/** settings 文档 → 当前默认 provider（两形式都读；非字符串 = 未设置）。 */
function readDefaultProvider(doc: JsonRecord | null): string | null {
  if (doc === null) return null
  for (const k of DEFAULT_PROVIDER_KEYS) {
    const v = doc[k]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

/** models.json 原始文档 → providers 表。doc === null（文件不存在，真实
    状态）→ 空表起步；providers 键缺失/不是 object → null（文件不合法，
    pi 自己也加载不了它——禁止在其上写入静默"修复"，铁律 12）。 */
function readProvidersTable(doc: JsonRecord | null): JsonRecord | null {
  if (doc === null) return {}
  const p = doc['providers']
  if (!isJsonRecord(p)) return null
  return p
}

/** pi_list_models 原始返回 → 目录条目（形状不符的行丢弃——目录只是展示
    数据面，真值在 pi 引擎里）。 */
function narrowCatalog(raw: unknown): PiModelEntry[] {
  if (!isJsonRecord(raw) || !Array.isArray(raw['models'])) return []
  const out: PiModelEntry[] = []
  for (const item of raw['models']) {
    if (!isJsonRecord(item)) continue
    const provider = item['provider']
    const id = item['id']
    if (typeof provider !== 'string' || typeof id !== 'string') continue
    const name = item['name']
    const cw = item['contextWindow']
    out.push({
      provider,
      id,
      name: typeof name === 'string' ? name : id,
      contextWindow: typeof cw === 'number' ? cw : 0,
    })
  }
  return out
}

// ── 子视图清单与标签 ────────────────────────────────────────────────

/** 子视图清单（hermes 同名导出；'local' 未随包——见文件头）。标签由宿主
    设置页左栏的 NAV_GROUPS 子项提供（hermes settings.nav 同源文案）。 */
export const PROVIDER_VIEWS = ['accounts', 'keys', 'custom-endpoints'] as const

export type ProviderView = (typeof PROVIDER_VIEWS)[number]

// ── 账号视图（hermes OAuthPicker / ConnectedProviderRow 的移植）─────

/** pi_oauth_providers 返回的登录入口行。 */
interface OAuthProviderEntry {
  id: string
  label: string
}

/** pi_oauth_status 的轮询形状：idle | pending | ok | err。 */
interface OAuthStatus {
  state: 'idle' | 'pending' | 'ok' | 'err'
  message: string
}

function AccountsView({
  auth,
  authError,
  onWantApiKey,
  refreshAuth,
}: {
  auth: PiAuthStatus | null
  authError: string | null
  onWantApiKey: () => void
  refreshAuth: () => void
}) {
  // OAuth 账号 = pi_auth_status 里 source==='auth' 且 credentialType==='oauth'
  // 的行（hermes GET /api/providers/oauth 的等价数据；configured = logged_in）。
  const accounts = useMemo(
    () => (auth !== null ? auth.providers.filter((r) => r.source === 'auth' && r.credentialType === 'oauth') : []),
    [auth],
  )
  const [disconnecting, setDisconnecting] = useState<string | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  // ── OAuth 登录流（pi_login.rs）：start（授权 URL + 本机回调监听）→
  //     轮询 status → ok 时后端已把凭据写进 auth.json，刷新即可见。
  const [oauthProviders, setOauthProviders] = useState<OAuthProviderEntry[] | null>(null)
  const [oauthProvidersError, setOauthProvidersError] = useState<string | null>(null)
  const [starting, setStarting] = useState<string | null>(null)
  // pending = 已 start、等回调（展示授权 URL 供浏览器没自动开时手贴）。
  const [pending, setPending] = useState<{ provider: string; url: string } | null>(null)
  const pollRef = useRef<number | null>(null)

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!inTauri) return
    let cancelled = false
    void (async () => {
      try {
        const r = await invoke<{ providers: OAuthProviderEntry[] }>('pi_oauth_providers')
        if (!cancelled) setOauthProviders(r.providers)
      } catch (e) {
        console.error('[pi] OAuth 提供方清单加载失败', e)
        if (!cancelled) setOauthProvidersError(describeIpcError(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 卸载时停轮询（轮询句柄是模块外窗口资源，不随组件回收）。
  useEffect(() => stopPolling, [stopPolling])

  const pollStatus = useCallback(
    async (provider: string) => {
      let s: OAuthStatus
      try {
        s = await invoke<OAuthStatus>('pi_oauth_status', { provider })
      } catch (e) {
        console.error('[pi] OAuth 状态查询失败', e)
        stopPolling()
        setStarting(null)
        setPending(null)
        setResult({ ok: false, text: describeIpcError(e) })
        return
      }
      if (s.state === 'ok') {
        stopPolling()
        setStarting(null)
        setPending(null)
        setResult({ ok: true, text: `${provider} ${s.message}` })
        refreshAuth()
      } else if (s.state === 'err') {
        stopPolling()
        setStarting(null)
        setPending(null)
        setResult({ ok: false, text: `${provider} 登录失败：${s.message}` })
      }
    },
    [refreshAuth, stopPolling],
  )

  async function handleLogin(provider: string) {
    setStarting(provider)
    setResult(null)
    try {
      const info = await invoke<{ url: string; redirectUri: string }>('pi_oauth_start', { provider })
      setPending({ provider, url: info.url })
      stopPolling()
      pollRef.current = window.setInterval(() => void pollStatus(provider), 1000)
    } catch (e) {
      console.error('[pi] OAuth 流程启动失败', e)
      setStarting(null)
      setResult({ ok: false, text: describeIpcError(e) })
    }
  }

  // 断开 = pi_delete_provider_key（auth.json 里该 provider 键整体移除，
  // OAuth 条目也一并删——pi_keys.rs 的「disconnect 等价面」）。
  // hermes 走 confirm() 对话框；宿主没有 confirm 原语，直接执行 + 内联
  // 反馈（见文件头交互偏差）。
  async function handleDisconnect(provider: string) {
    setDisconnecting(provider)
    setResult(null)
    try {
      await invoke<boolean>('pi_delete_provider_key', { provider })
      setResult({ ok: true, text: `${provider} 已移除。` })
      refreshAuth()
    } catch (e) {
      console.error('[pi] 断开连接失败', e)
      setResult({ ok: false, text: `无法移除 ${provider}：${describeIpcError(e)}` })
    } finally {
      setDisconnecting(null)
    }
  }

  return (
    <section className="set-section">
      {/* 标题行（hermes SettingsCategoryHeading「连接账号」+ 右侧
          「改用 API 密钥？」切到 keys 子视图） */}
      <div className="set-actions">
        <h4 className="set-sub-title" style={{ margin: 0 }}>
          连接账号
        </h4>
        <button className="set-btn" onClick={onWantApiKey} type="button">
          改用 API 密钥？
        </button>
      </div>
      <p className="set-hint">
        使用订阅登录，无需复制 API 密钥。点击登录会打开系统浏览器完成授权，
        回调到本机后凭据自动写入 pi 的 auth.json。
      </p>
      <div className="set-actions">
        {/* hermes 是 per-provider 登录按钮（onboarding overlay 驱动 OAuth）；
            本宿主走 pi::auth 的 localhost 回调流（pi_login.rs）。四家之外
            的提供方（kimi/copilot/gitlab）是设备码流，不在清单——不列假入口。 */}
        {oauthProviders === null && oauthProvidersError === null && (
          <span className="set-file-missing">登录入口加载中…</span>
        )}
        {oauthProviders !== null &&
          oauthProviders.map((p) => (
            <button
              className="set-btn"
              disabled={starting !== null}
              key={p.id}
              onClick={() => void handleLogin(p.id)}
              type="button"
            >
              {starting === p.id ? '等待授权…' : `登录 ${p.label}`}
            </button>
          ))}
        {oauthProvidersError !== null && <div className="set-err">{oauthProvidersError}</div>}
      </div>

      {pending !== null && (
        <div className="set-hint">
          {pending.provider} 等待浏览器回调（最长 5 分钟）。若浏览器没有自动打开，
          手动访问：
          <br />
          <code style={{ userSelect: 'text', wordBreak: 'break-all' }}>{pending.url}</code>
        </div>
      )}

      {authError !== null && <div className="set-err">{authError}</div>}
      {auth === null && authError === null && <span className="set-file-missing">加载中…</span>}

      {auth !== null && accounts.length > 0 && (
        <>
          {/* hermes GroupLabel「已连接」 */}
          <p className="set-hint">已连接</p>
          <div className="set-rows">
            {accounts.map((a) => (
              <div className="set-row" key={`oauth-${a.provider}`}>
                <span className="set-row-provider">{a.provider}</span>
                <span className="set-row-ok">已连接 ✓</span>
                <span className="set-row-source">auth.json · {a.credentialType ?? 'unknown'}</span>
                <span className="set-actions">
                  <button
                    className="set-btn"
                    disabled={disconnecting === a.provider}
                    onClick={() => void handleDisconnect(a.provider)}
                    type="button"
                  >
                    断开连接
                  </button>
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {auth !== null && accounts.length === 0 && <p className="set-hint">没有已连接的 OAuth 账号。</p>}

      {result !== null && <div className={result.ok ? 'set-saved' : 'set-err'}>{result.text}</div>}
    </section>
  )
}

// ── API 密钥视图（hermes keys 目录 + credential-key-ui 的移植）──────

function KeysView({
  auth,
  authError,
  onOpenCustomEndpoints,
  refreshAuth,
}: {
  auth: PiAuthStatus | null
  authError: string | null
  onOpenCustomEndpoints: () => void
  refreshAuth: () => void
}) {
  // 自由文本过滤（hermes SearchField + normalize：小写化匹配提供方名 /
  // 键名 / 凭据类型 / 环境变量名）。
  const [query, setQuery] = useState('')
  // 每行的密钥草稿（键 = provider id）。
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const q = query.trim().toLowerCase()
  const rows = useMemo(() => {
    const all = auth?.providers ?? []
    if (q === '') return all
    return all.filter((r) => {
      const hay = [
        r.provider,
        r.credentialType ?? '',
        r.source,
        r.envVar ?? '',
        ...(r.envKeys ?? []).map((k) => k.name),
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [auth, q])

  // 写入 = pi_set_provider_key（auth.json 落 {"type":"api_key","key":…}）；
  // hermes 的 PUT /api/env 等价面。成功后刷新 pi_auth_status（存在性变化）。
  async function handleSave(provider: string) {
    const key = (drafts[provider] ?? '').trim()
    if (key === '') return
    setBusy(provider)
    setResult(null)
    try {
      await invoke('pi_set_provider_key', { key, provider })
      setDrafts((prev) => ({ ...prev, [provider]: '' }))
      setResult({ ok: true, text: `${provider} 已更新。` })
      refreshAuth()
    } catch (e) {
      console.error('[pi] 凭据写入失败', e)
      setResult({ ok: false, text: `保存 ${provider} 失败：${describeIpcError(e)}` })
    } finally {
      setBusy(null)
    }
  }

  // 清除 = pi_delete_provider_key（仅 auth 源的行——它只动 auth.json，
  // 与 settings-overlay 既有「清除」的显示条件一致）。幂等：键不存在
  // 返回 false（真实状态，如实报告）。
  async function handleClear(provider: string) {
    setBusy(provider)
    setResult(null)
    try {
      const removed = await invoke<boolean>('pi_delete_provider_key', { provider })
      setResult({ ok: true, text: removed ? `${provider} 已移除。` : `${provider} 本无存储凭据。` })
      refreshAuth()
    } catch (e) {
      console.error('[pi] 凭据删除失败', e)
      setResult({ ok: false, text: `移除 ${provider} 失败：${describeIpcError(e)}` })
    } finally {
      setBusy(null)
    }
  }

  const hasCatalog = auth !== null && auth.providers.length > 0

  return (
    <section className="set-section">
      <div className="set-actions">
        <h4 className="set-sub-title" style={{ margin: 0 }}>
          API 密钥
        </h4>
      </div>
      <p className="set-hint">
        各提供方的凭据状态（pi 的 auth.json 与 models.json；只报存在性，
        绝不显示 key 内容——pi 凭据只写不读，hermes 的「显示值」按钮省略）。
        写入 = 在 auth.json 落一条{' '}
        <span className="set-code">{'{"type":"api_key","key":…}'}</span>{' '}
        凭据；清除 = 该提供方存储凭据整体移除。环境变量凭据的状态只读——
        环境变量在系统层设置。
      </p>

      {/* 本地 / 自定义端点入口（hermes keys 视图顶部的 LocalEndpointRow：
          两行行按钮，这里按宿主控件语言压成按钮 + 说明行）。点击切到
          自定义端点子视图（hermes 走 onboarding overlay 的
          startManualLocalEndpoint，本宿主没有 onboarding 面）。 */}
      <div className="set-actions">
        <button className="set-btn" onClick={onOpenCustomEndpoints} type="button">
          本地 / 自定义端点 →
        </button>
        <span className="set-row-source">将 pi 指向任意 OpenAI 兼容端点（Zyphra、vLLM、llama.cpp、Ollama 等）</span>
      </div>

      {hasCatalog && (
        <input
          aria-label="搜索提供方"
          className="set-input"
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索提供方…"
          style={{ maxWidth: 280 }}
          type="text"
          value={query}
        />
      )}

      {authError !== null && <div className="set-err">{authError}</div>}
      {auth === null && authError === null && <span className="set-file-missing">加载中…</span>}

      {auth !== null && auth.providers.length === 0 && (
        <p className="set-hint">没有可用的提供方 API 密钥。</p>
      )}
      {auth !== null && auth.providers.length > 0 && rows.length === 0 && (
        <p className="set-hint">没有匹配的提供方。</p>
      )}

      {rows.length > 0 && (
        <div className="set-rows">
          {rows.map((row) => (
            <div className="set-row" key={`key-${row.provider}`}>
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
              {/* 已声明的环境变量键名 + 置位状态（pi resolve 链的一环；
                  只报名字与存在性，绝不报 key 内容）。 */}
              {row.envVar !== undefined && (
                <span className={`set-row-env${row.envSet ? '' : ' set-row-env-off'}`}>
                  {row.envVar}（{row.envSet ? '已设置' : '未设置'}）
                </span>
              )}
              {row.envKeys?.map((k) => (
                <span className={`set-row-env${k.set ? '' : ' set-row-env-off'}`} key={k.name}>
                  {k.name}（{k.set ? '已设置' : '未设置'}）
                </span>
              ))}
              <span className="set-actions">
                <input
                  aria-label={`${row.provider} 的 API 密钥`}
                  className="set-input"
                  disabled={busy === row.provider}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [row.provider]: e.target.value }))}
                  placeholder={row.configured ? '覆盖现有密钥' : `粘贴 ${row.provider} 密钥`}
                  style={{ width: 200 }}
                  type="password"
                  value={drafts[row.provider] ?? ''}
                />
                <button
                  className="set-btn set-btn-primary"
                  disabled={busy === row.provider || (drafts[row.provider] ?? '').trim() === ''}
                  onClick={() => void handleSave(row.provider)}
                  type="button"
                >
                  写入
                </button>
                {row.source === 'auth' && (
                  <button
                    className="set-btn"
                    disabled={busy === row.provider}
                    onClick={() => void handleClear(row.provider)}
                    type="button"
                  >
                    清除
                  </button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {result !== null && <div className={result.ok ? 'set-saved' : 'set-err'}>{result.text}</div>}
    </section>
  )
}

// ── 自定义端点视图（hermes custom-endpoints-settings 的移植）────────

/** 表单形状（hermes EndpointForm 的 rpi 对应物：name 并入 id；`apiMode`
    **持久化**为 provider 条目的 `api` 字段——rpi 没有协议自动检测，
    `ProviderConfig.api` 缺省 = anthropic-messages、openai-completions/
    openai-responses 必须显式声明（rpi-runtime/src/config.rs:201-215）。
    discoverModels = 保存时 GET {base}/models 拉全量模型（动作开关，
    不落盘）。 */
interface EndpointForm {
  apiKey: string
  apiMode: string
  baseUrl: string
  contextLength: string
  discoverModels: boolean
  id: string
  makeDefault: boolean
  model: string
}

const EMPTY_FORM: EndpointForm = {
  apiKey: '',
  apiMode: 'openai-completions',
  baseUrl: '',
  contextLength: '',
  discoverModels: true,
  id: '',
  makeDefault: true,
  model: '',
}

/** API 模式选项（值 = rpi `ProviderConfig.api` 的合法字符串，逐字）。
    没有「自动检测」：rpi 缺省就是 Anthropic Messages，把缺省标成"自动"
    会让 OpenAI 兼容端点静默走错协议（2026-11-14 实锤）。本页表单的定位
    是"添加兼容 OpenAI 的端点"，默认选 Chat Completions。 */
const API_MODE_OPTIONS: readonly { id: string; label: string }[] = [
  { id: 'openai-completions', label: 'Chat Completions' },
  { id: 'openai-responses', label: 'Responses API' },
  { id: 'anthropic-messages', label: 'Anthropic Messages' },
]

/** provider 条目 → 表单 API 模式（缺省/未知 = anthropic-messages——
    与 rpi 的推断一致，如实显示实际会用的协议）。 */
function apiModeOf(entry: JsonRecord): string {
  const api = entry['api']
  if (typeof api === 'string' && API_MODE_OPTIONS.some((o) => o.id === api)) return api
  return 'anthropic-messages'
}

/** 列表行摘要（hermes CustomEndpoint 的 pi 对应物：id=provider 键、
    name=id；entry 保留原始条目——「使用」要读 models[0]）。 */
interface EndpointRow {
  baseUrl: string
  entry: JsonRecord
  hasApiKey: boolean
  id: string
  modelContextWindow: number | null
  modelCount: number
  modelId: string | null
}

/** providers 表条目 → 列表行摘要（字段全部窄化读取，形状不符按缺省）。 */
function summarizeEndpoint(id: string, entry: JsonRecord): EndpointRow | null {
  const baseUrl = entry['baseUrl']
  // 有 baseUrl 的条目 = 自定义端点（任务映射）；只带 apiKey/models 的
  // 条目是内置 provider 的覆写，不进列表（写入时原样保留，不 clobber）。
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return null
  const models = Array.isArray(entry['models']) ? entry['models'].filter(isJsonRecord) : []
  const first = models[0]
  const firstId = first !== undefined ? first['id'] : undefined
  const firstCtx = first !== undefined ? first['contextWindow'] : undefined
  const apiKey = entry['apiKey']
  return {
    baseUrl,
    entry,
    hasApiKey: typeof apiKey === 'string' && apiKey !== '',
    id,
    modelContextWindow: typeof firstCtx === 'number' ? firstCtx : null,
    modelCount: models.length,
    modelId: typeof firstId === 'string' ? firstId : null,
  }
}

function CustomEndpointsView() {
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  // models.json / settings.json 原始文档（null = 文件不存在——保存将创建）。
  const [modelsDoc, setModelsDoc] = useState<JsonRecord | null>(null)
  const [settingsDoc, setSettingsDoc] = useState<JsonRecord | null>(null)
  // pi 模型目录（pi_list_models）：默认模型输入的联想候选。
  const [catalog, setCatalog] = useState<PiModelEntry[]>([])

  const [form, setForm] = useState<EndpointForm>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [activating, setActivating] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  // 「测试」结果（pi_endpoint_validate：GET {base}/models，ok/err 如实显示）。
  const [testing, setTesting] = useState(false)
  const [testNote, setTestNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  // 端点测试（hermes validate 的本地等价面）：密钥留空时以无凭据探测
  //（编辑态「留空保留当前密钥」= 密钥只写不读，测试拿不到已存值——
  // 需要鉴权的端点会如实返回 401，不带假成功）。
  async function handleTest() {
    setTesting(true)
    setTestNote(null)
    try {
      const r = await invoke<{ ok: boolean; status: number; models: string[]; message: string }>(
        'pi_endpoint_validate',
        {
          baseUrl: form.baseUrl.trim(),
          apiKey: form.apiKey.trim() === '' ? null : form.apiKey.trim(),
        },
      )
      const preview = r.ok && r.models.length > 0
        ? `：${r.models.slice(0, 5).join('、')}${r.models.length > 5 ? ` …（共 ${r.models.length} 个）` : ''}`
        : ''
      setTestNote({ ok: r.ok, text: `${r.message}${preview}` })
    } catch (e) {
      console.error('[pi] 端点测试失败', e)
      setTestNote({ ok: false, text: describeIpcError(e) })
    } finally {
      setTesting(false)
    }
  }

  // 初次加载：models.json + settings.json + 模型目录（hermes 的
  // getCustomEndpoints + 模型目录查询的等价面）。cancelled 旗标丢弃
  // 陈旧完成（host settings-overlay 同款生命周期守卫）。
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setModelsDoc(null)
    setSettingsDoc(null)
    setCatalog([])
    setForm(EMPTY_FORM)
    setTestNote(null)
    setResult(null)

    void (async () => {
      try {
        const [rawModels, rawSettings, rawCatalog] = await Promise.all([
          invoke<unknown>('pi_get_models_config'),
          invoke<unknown>('pi_get_settings'),
          invoke<unknown>('pi_list_models'),
        ])
        if (cancelled) return
        if (rawModels !== null && !isJsonRecord(rawModels)) {
          // models.json 存在但不是 object——pi 自己也加载不了；如实报错，
          // 不提供写入面（写回 = 假装修复坏文件，禁止）。
          setLoadError('models.json 不是 JSON object——请先修正原始文档（pi 无法加载该文件）')
        } else {
          setModelsDoc(rawModels)
        }
        // settings 形状异常只影响「已启用」标记与启用写入——列表照常展示。
        setSettingsDoc(isJsonRecord(rawSettings) ? rawSettings : null)
        setCatalog(narrowCatalog(rawCatalog))
      } catch (e) {
        if (!cancelled) {
          console.error('[pi] 自定义端点加载失败', e)
          setLoadError(describeIpcError(e))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const providersTable = useMemo(() => readProvidersTable(modelsDoc), [modelsDoc])
  const activeProvider = readDefaultProvider(settingsDoc)

  const endpoints = useMemo(() => {
    if (providersTable === null) return []
    const out: EndpointRow[] = []
    for (const [id, raw] of Object.entries(providersTable)) {
      if (!isJsonRecord(raw)) continue
      const row = summarizeEndpoint(id, raw)
      if (row !== null) out.push(row)
    }
    return out
  }, [providersTable])

  // 正在编辑的条目（form.id 非空 = 编辑态；id 输入禁用，见文件头偏差）。
  const editingEp = form.id === '' ? null : (endpoints.find((e) => e.id === form.id) ?? null)

  // 默认模型联想候选：pi 目录里该 provider 的模型 + 当前输入值（去重，
  // hermes withActive 语义——自定义 id 不在目录里时保持可见可选）。
  const modelOptions = useMemo(() => {
    const ids = catalog.filter((m) => m.provider === form.id.trim()).map((m) => m.id)
    const model = form.model.trim()
    if (model !== '' && !ids.includes(model)) ids.unshift(model)
    return ids
  }, [catalog, form.id, form.model])

  /** 行点击 → 表单（hermes formFromEndpoint：不回显已有 apiKey）。 */
  function loadForm(ep: EndpointRow) {
    setForm({
      apiKey: '',
      apiMode: apiModeOf(ep.entry),
      baseUrl: ep.baseUrl,
      contextLength: ep.modelContextWindow !== null ? String(ep.modelContextWindow) : '',
      discoverModels: true,
      id: ep.id,
      makeDefault: activeProvider === ep.id,
      model: ep.modelId ?? '',
    })
    setTestNote(null)
    setResult(null)
  }

  /** 读最新 settings → 设 default_provider（+ default_model）→ 整体写回。
      每次现读不缓存：settings.json 可能被「安全」节的原始编辑器改过，
      用陈旧文档写回会丢用户手改（丢失更新）。 */
  async function writeDefault(id: string, modelId: string | null): Promise<void> {
    const raw = await invoke<unknown>('pi_get_settings')
    if (raw !== null && !isJsonRecord(raw)) {
      throw new Error('settings.json 不是 JSON object——pi 无法加载它，写入中止')
    }
    const doc: JsonRecord = raw === null ? {} : { ...raw }
    doc[existingKeyForm(doc, DEFAULT_PROVIDER_KEYS)] = id
    if (modelId !== null) doc[existingKeyForm(doc, DEFAULT_MODEL_KEYS)] = modelId
    await invoke('pi_set_settings', { value: doc })
    setSettingsDoc(doc)
  }

  // 「使用」= activate：写 settings.json 的 default_provider / default_model
  // （hermes activateCustomEndpoint 的等价面；default_model 取端点目录
  // 首条——models 未知时只设 provider）。
  async function handleActivate(ep: EndpointRow) {
    setActivating(ep.id)
    setResult(null)
    try {
      await writeDefault(ep.id, ep.modelId)
      setResult({
        ok: true,
        text: ep.modelId !== null ? `${ep.id} 已启用（默认模型 ${ep.modelId}）。` : `${ep.id} 已启用。`,
      })
    } catch (e) {
      console.error('[pi] 启用端点失败', e)
      setResult({ ok: false, text: `启用失败：${describeIpcError(e)}` })
    } finally {
      setActivating(null)
    }
  }

  // 保存 = models.json 整体替换写入（pi 语义：nested 对象不合并——
  // 永远送完整文档）。条目按 { ...existing, baseUrl, apiKey?, models? }
  // 变异：既有的 headers/compat/modelOverrides 等手工配置原样保留。
  // 「用于新对话」勾选时（hermes 的 make_default）接着写 settings 启用。
  async function handleSave() {
    const id = form.id.trim()
    const baseUrl = form.baseUrl.trim()
    const model = form.model.trim()
    if (id === '' || baseUrl === '' || model === '' || providersTable === null) return
    setSaving(true)
    setResult(null)
    try {
      const raw = providersTable[id]
      const existing = isJsonRecord(raw) ? raw : {}
      const entry: JsonRecord = { ...existing }
      entry['baseUrl'] = baseUrl
      // 协议必须显式落盘（rpi 无自动检测；缺省 = anthropic-messages）。
      entry['api'] = form.apiMode
      const apiKey = form.apiKey.trim()
      // 留空 = 保留现有密钥（hermes apiKeyNewPlaceholder 语义）；新条目
      // 留空 = 不写 apiKey 键。密钥内容只写不读。
      if (apiKey !== '') entry['apiKey'] = apiKey
      // models：rpi **不自动发现**——目录 = 内置 + models.json 里显式列出
      // 的 models[]。勾「发现模型」时保存前先 GET {base}/models（OpenAI
      // 兼容端点的标准发现面）把全量 id 写进来；探测失败 = 错误可见并
      // 中止保存，**不静默退化成单模型**（铁律 12；另给出取消勾选的退路）。
      // 既有条目的逐模型配置（contextWindow 等）按 id 合并不丢。
      const existingModels = Array.isArray(existing['models'])
        ? existing['models'].filter(isJsonRecord)
        : []
      const byId = new Map(existingModels.map((m) => [String(m['id']), m]))
      let modelIds: string[] = [model]
      if (form.discoverModels) {
        // 服务端探测：apiKey 留空时宿主从 models.json 借用已存密钥（编辑态
        // 表单不回显密钥，但发现仍需鉴权）。
        const probe = await invoke<{
          ok: boolean
          status: number
          models: string[]
          message: string
        }>('pi_discover_models', {
          providerId: id,
          baseUrl,
          apiKey: apiKey === '' ? null : apiKey,
        })
        if (!probe.ok || probe.models.length === 0) {
          throw new Error(
            `模型发现失败：${probe.message}${probe.ok ? '（端点没有返回模型列表）' : ''}——取消勾选「发现模型」可只保存默认模型`,
          )
        }
        modelIds = probe.models.includes(model) ? probe.models : [model, ...probe.models]
      }
      const ctx = Number.parseInt(form.contextLength, 10)
      const models: JsonRecord[] = modelIds.map((mid) => {
        const prev = byId.get(mid)
        return prev !== undefined ? { ...prev } : { id: mid }
      })
      // 表单的「上下文」只作用于默认模型（models[0]）。
      if (Number.isFinite(ctx) && ctx > 0) models[0]['contextWindow'] = ctx
      entry['models'] = models
      const doc: JsonRecord = modelsDoc !== null ? { ...modelsDoc } : {}
      doc['providers'] = { ...providersTable, [id]: entry }
      await invoke('pi_set_models_config', { value: doc })
      setModelsDoc(doc)
      const discovered = form.discoverModels ? models.length : 0
      const summary =
        discovered > 1
          ? `（发现 ${discovered} 个模型）`
          : ''
      if (form.makeDefault) {
        try {
          await writeDefault(id, model)
          setResult({ ok: true, text: `自定义端点已保存${summary}并设为新对话默认。` })
        } catch (e) {
          // 端点本体已保存，启用失败——失败可见（铁律 12），不吞。
          console.error('[pi] 保存后启用失败', e)
          setResult({ ok: false, text: `端点已保存${summary}，但写入默认模型失败：${describeIpcError(e)}` })
        }
      } else {
        setResult({ ok: true, text: `自定义端点已保存${summary}。` })
      }
    } catch (e) {
      console.error('[pi] models.json 写入失败', e)
      setResult({ ok: false, text: `保存失败：${describeIpcError(e)}` })
    } finally {
      setSaving(false)
    }
  }

  // 删除 = providers 表去键 + 整体替换写回（hermes deleteCustomEndpoint
  // 的等价面）。hermes 有 confirm 对话框；宿主没有 confirm 原语，直接
  // 删 + 内联反馈（文件头交互偏差）。删的是当前默认端点时，settings 的
  // default_provider 会悬空——明确提示，不静默。
  async function handleDelete(ep: EndpointRow) {
    if (providersTable === null) return
    const wasActive = activeProvider === ep.id
    setDeleting(ep.id)
    setResult(null)
    try {
      const table: JsonRecord = { ...providersTable }
      delete table[ep.id]
      const doc: JsonRecord = modelsDoc !== null ? { ...modelsDoc } : {}
      doc['providers'] = table
      await invoke('pi_set_models_config', { value: doc })
      setModelsDoc(doc)
      if (form.id === ep.id) {
        setForm(EMPTY_FORM)
        setTestNote(null)
      }
      setResult({
        ok: true,
        text: wasActive
          ? `${ep.id} 已删除。（注意：它此前是新对话默认——settings.json 的 default_provider 仍指向它，请重建端点或改设默认）`
          : `${ep.id} 已删除。`,
      })
    } catch (e) {
      console.error('[pi] 端点删除失败', e)
      setResult({ ok: false, text: `删除失败：${describeIpcError(e)}` })
    } finally {
      setDeleting(null)
    }
  }

  // hermes canSave：name && baseUrl && model；name 并入 id 后 = id &&
  // baseUrl && model（pi 自定义端点必须声明 models 才可用，强制合理）。
  const canSave =
    providersTable !== null &&
    form.id.trim() !== '' &&
    form.baseUrl.trim() !== '' &&
    form.model.trim() !== ''

  return (
    <section className="set-section">
      <div className="set-actions">
        <h4 className="set-sub-title" style={{ margin: 0 }}>
          自定义端点
        </h4>
        {endpoints.length > 0 && <span className="set-row-source">{endpoints.length}</span>}
      </div>
      <p className="set-hint">
        端点存储在 pi 的 <span className="set-code">models.json</span> providers
        表（保存/删除 = 整体替换写入；写入前经 pi 自身 schema 校验，类型不符会被拒绝）。
      </p>

      {loadError !== null && <div className="set-err">{loadError}</div>}
      {loading && <span className="set-file-missing">加载中…</span>}

      {!loading && (
        <>
          {/* ── 端点列表（hermes 的端点卡片行）── */}
          {providersTable === null && loadError === null && (
            <div className="set-err">
              models.json 缺 providers 表或它不是 object——pi 无法加载该文件；请先修正原始文档再管理端点。
            </div>
          )}
          {providersTable !== null && endpoints.length === 0 && (
            <p className="set-hint">暂无自定义端点。在下方添加兼容 OpenAI 的端点。</p>
          )}
          {providersTable !== null && endpoints.length > 0 && (
            <div className="set-rows">
              {endpoints.map((ep) => (
                <div className="set-row" key={`ep-${ep.id}`}>
                  <span className="set-row-provider">{ep.id}</span>
                  {activeProvider === ep.id && <span className="set-row-ok">已启用 ✓</span>}
                  <span className="set-row-source">{ep.baseUrl}</span>
                  {ep.modelId !== null && <span className="set-row-env">{ep.modelId}</span>}
                  {ep.modelCount > 1 && <span className="set-row-source">{ep.modelCount} 个模型</span>}
                  {ep.hasApiKey && <span className="set-row-source">已设置 API 密钥</span>}
                  <span className="set-actions">
                    <button
                      className="set-btn"
                      disabled={activeProvider === ep.id || activating === ep.id}
                      onClick={() => void handleActivate(ep)}
                      type="button"
                    >
                      使用
                    </button>
                    <button className="set-btn" onClick={() => loadForm(ep)} type="button">
                      编辑
                    </button>
                    <button
                      className="set-btn"
                      disabled={deleting === ep.id}
                      onClick={() => void handleDelete(ep)}
                      type="button"
                    >
                      删除
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* ── 添加/编辑表单 ── */}
          <h4 className="set-sub-title">{form.id !== '' ? '编辑端点' : '添加端点'}</h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="set-field">
              <span className="set-field-label">提供商 ID</span>
              <div className="set-field-control">
                <input
                  aria-label="提供商 ID"
                  className="set-input"
                  disabled={form.id !== ''}
                  onChange={(e) => setForm((c) => ({ ...c, id: e.target.value }))}
                  placeholder="axet-proxy"
                  type="text"
                  value={form.id}
                />
                <span className="set-field-note">
                  pi 用 provider id 作为名称与存储键（hermes 的「名称」字段并入 id）；编辑时禁用——改名 =
                  另建新端点。
                </span>
              </div>
            </div>

            <div className="set-field">
              <span className="set-field-label">端点 URL</span>
              <div className="set-field-control">
                <input
                  aria-label="端点 URL"
                  className="set-input"
                  onChange={(e) => setForm((c) => ({ ...c, baseUrl: e.target.value }))}
                  placeholder="http://127.0.0.1:8081/v1"
                  type="text"
                  value={form.baseUrl}
                />
              </div>
            </div>

            {/* API 模式：写 provider 条目的 `api` 字段（rpi 唯一协议开关；
                没有自动检测——缺省 = Anthropic Messages，OpenAI 兼容端点
                必须在此选 Chat Completions / Responses API）。 */}
            <div className="set-field" title="写入 models.json 的 provider.api">
              <span className="set-field-label">API 模式</span>
              <div className="set-field-control">
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {API_MODE_OPTIONS.map((o) => (
                    <button
                      className="set-btn"
                      key={o.id}
                      onClick={() => setForm((c) => ({ ...c, apiMode: o.id }))}
                      style={form.apiMode === o.id ? { outline: '2px solid var(--brand)', outlineOffset: 1 } : undefined}
                      type="button"
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
                <span className="set-field-note">
                  保存为 provider.api（rpi 无自动检测；缺省即 Anthropic Messages）。
                </span>
              </div>
            </div>

            <div className="set-field">
              <span className="set-field-label">默认模型</span>
              <div className="set-field-control">
                <input
                  aria-label="默认模型"
                  className="set-input"
                  list="providers-model-options"
                  onChange={(e) => setForm((c) => ({ ...c, model: e.target.value }))}
                  placeholder="gpt-5.4"
                  type="text"
                  value={form.model}
                />
                {/* 原生 datalist 充当 hermes 的 ComboboxInput：可输入
                    也可从 pi 目录（该 provider 的条目）里挑。 */}
                <datalist id="providers-model-options">
                  {modelOptions.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
                <span className="set-field-note">写入端点 models 目录的首条；可从 pi 目录选择或直接输入自定义 id。</span>
              </div>
            </div>

            <div className="set-field">
              <span className="set-field-label">上下文</span>
              <div className="set-field-control">
                <input
                  aria-label="上下文长度"
                  className="set-input"
                  inputMode="numeric"
                  onChange={(e) => setForm((c) => ({ ...c, contextLength: e.target.value }))}
                  placeholder="自动"
                  type="text"
                  value={form.contextLength}
                />
                <span className="set-field-note">写入默认模型条目的 contextWindow（tokens）。</span>
              </div>
            </div>

            <div className="set-field">
              <span className="set-field-label">API 密钥</span>
              <div className="set-field-control">
                <input
                  aria-label="API 密钥"
                  className="set-input"
                  onChange={(e) => setForm((c) => ({ ...c, apiKey: e.target.value }))}
                  placeholder={editingEp !== null && editingEp.hasApiKey ? '留空以保留当前密钥' : '可选'}
                  type="password"
                  value={form.apiKey}
                />
                <span className="set-field-note">存进 models.json 的 apiKey 字段；只写不读，保存后绝不回显内容。</span>
              </div>
            </div>

            <div className="set-field">
              <span className="set-field-label">选项</span>
              <div className="set-field-control">
                <label style={{ alignItems: 'center', display: 'flex', gap: 6 }}>
                  <input
                    checked={form.makeDefault}
                    onChange={(e) => setForm((c) => ({ ...c, makeDefault: e.target.checked }))}
                    type="checkbox"
                  />
                  用于新对话（保存即设为默认）
                </label>
                <label style={{ alignItems: 'center', display: 'flex', gap: 6 }} title="保存时 GET {端点URL}/models 拉全部模型 id 写进 provider.models">
                  <input checked={form.discoverModels} onChange={(e) => setForm((c) => ({ ...c, discoverModels: e.target.checked }))} type="checkbox" />
                  发现模型（保存时 GET /models 自动列出全部模型）
                </label>
                {editingEp !== null && editingEp.modelCount > 1 && (
                  <span className="set-field-note">
                    该条目已声明 {editingEp.modelCount} 个模型——勾选「发现模型」会重新拉取并按 id 保留既有配置；
                    取消勾选则只保留「默认模型」一条。
                  </span>
                )}
              </div>
            </div>

            {/* 按钮统一靠右（2026-11-24 用户："按钮都在右边"）。 */}
            <div className="set-actions" style={{ justifyContent: 'flex-end' }}>
              {/* 测试：pi_endpoint_validate（pi 的 http client，与提供方
                  请求同一栈）——GET {base}/models + Bearer，结果如实内联。 */}
              <button
                className="set-btn"
                disabled={testing || form.baseUrl.trim() === ''}
                onClick={() => void handleTest()}
                type="button"
              >
                {testing ? '测试中…' : '测试'}
              </button>
              <button className="set-btn set-btn-primary" disabled={saving || !canSave} onClick={() => void handleSave()} type="button">
                保存
              </button>
              {form.id !== '' && (
                <button
                  className="set-btn"
                  onClick={() => {
                    setForm(EMPTY_FORM)
                    setTestNote(null)
                  }}
                  type="button"
                >
                  新建端点
                </button>
              )}
            </div>

            {testNote !== null && (
              <div className={testNote.ok ? 'set-saved' : 'set-err'}>{testNote.text}</div>
            )}
            {result !== null && <div className={result.ok ? 'set-saved' : 'set-err'}>{result.text}</div>}
          </div>
        </>
      )}
    </section>
  )
}

// ── 根组件 ──────────────────────────────────────────────────────────

/** hermes「提供方」设置页的移植根组件。子视图 = **受控**（宿主设置页左栏
    的「模型」子项就是 hermes 的 pview 侧栏子导航，唯一导航源）；账号视图
    内「改用 API 密钥？」等跨视图跳转也走 onViewChange 回写左栏选中项。 */
export function ProvidersSettings({
  view,
  onViewChange,
}: {
  view: ProviderView
  onViewChange: (v: ProviderView) => void
}) {
  const [auth, setAuth] = useState<PiAuthStatus | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)

  // 凭据目录（hermes GET /api/env 的等价面）：账号与密钥两个子视图共用
  // 一份 + 一个刷新回调。错误不吞——authError 内联显示（铁律 12）。
  const refreshAuth = useCallback(() => {
    void invoke<PiAuthStatus>('pi_auth_status')
      .then((res) => {
        setAuth(res)
        setAuthError(null)
      })
      .catch((e) => {
        console.error('[pi] 凭据状态获取失败', e)
        setAuthError(describeIpcError(e))
      })
  }, [])

  useEffect(() => {
    refreshAuth()
  }, [refreshAuth])

  return (
    <div className="set-section">
      {view === 'accounts' && (
        <AccountsView
          auth={auth}
          authError={authError}
          onWantApiKey={() => onViewChange('keys')}
          refreshAuth={refreshAuth}
        />
      )}
      {view === 'keys' && (
        <KeysView
          auth={auth}
          authError={authError}
          onOpenCustomEndpoints={() => onViewChange('custom-endpoints')}
          refreshAuth={refreshAuth}
        />
      )}
      {view === 'custom-endpoints' && <CustomEndpointsView />}
    </div>
  )
}
