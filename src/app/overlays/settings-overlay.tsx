/**
 * 全局设置浮层（pi-integration.md §7-7 设置页接线，MVP 四段：模型 /
 * 提供方凭据 / 高级·原始配置 / 关于）。
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

import { useCallback, useEffect, useMemo, useState } from 'react'
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
          setSettingsText(JSON.stringify(doc, null, 2))
          setSettingsMissing(false)
          setSettingsError(null)
          setModelSaved('默认模型已写入 settings.json（pi 创建新会话时读取）')
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
