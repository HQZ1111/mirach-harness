/**
 * 「技能与工具」浮层——左栏入口条 capabilities 项的数据面。pi 资源只读
 * 管理：pi_list_resources（pi_resources.rs）列举 skills/prompts +
 * extensions/packages 配置 + enable_skill_commands 开关状态 + loader 诊断。
 *
 * loader = pi 自己的 resources.rs（:950 load_skills / :1414
 * load_prompt_templates）——frontmatter 校验/碰撞裁决零漂移；诊断逐条
 * 如实显示（坏文件可见，禁止静默）。只读——skill 文件的增改是 pi 的事，
 * 面板不提供写入口。
 *
 * hermes 对应物 = capabilities 页（app/capabilities/index.tsx SkillsTab/
 * ToolsetsTab）—— hermes 的安装/开关走 REST 配置面，pi 侧只读列举是
 * pi 语义的诚实形态（resources 由 pi 起跑时装载，桌面侧不改）。
 *
 * 结构照抄 settings-overlay.tsx（portal 到 body + .set-overlay 系类 +
 * escape-layers 分层）——同一族的全局面，z 130 盖住一切 transient 面。
 */

import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { invoke } from '@tauri-apps/api/core'
import { RefreshCw, XIcon } from 'lucide-react'
import { createStore, useStore } from 'zustand'

import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'

/** pi_list_resources 行（pi Skill，resources.rs:134-142 字段映射） */
interface PiSkillRow {
  name: string
  description: string
  path: string
  source: string
  disableModelInvocation?: boolean
}

/** pi PromptTemplate（resources.rs:162-169 字段映射） */
interface PiPromptRow {
  name: string
  description: string
  path: string
  source: string
}

/** loader 诊断（resources.rs:106-112；kind = Warning | Collision） */
interface PiResourceDiagnostic {
  kind: string
  message: string
  path: string
}

interface PiResources {
  agentDir: string
  skills: PiSkillRow[]
  prompts: PiPromptRow[]
  diagnostics: PiResourceDiagnostic[]
  extensions: string[]
  packages: string[]
  enableSkillCommands: boolean | null
}

/** 折叠/展开开关 store（浮层自用，无外部消费方——本地 state 即可） */
function useTab(initial: 'skills' | 'prompts' | 'config'): [
  'skills' | 'prompts' | 'config',
  (t: 'skills' | 'prompts' | 'config') => void,
] {
  const [tab, setTab] = useState(initial)
  return [tab, setTab]
}

/** 「技能与工具」浮层（entry-bar capabilities 项的数据面）。 */
export function ResourcesDialog({ onClose }: { onClose: () => void }) {
  const [resources, setResources] = useState<PiResources | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [tab, setTab] = useTab('skills')

  const load = async () => {
    try {
      const res = await invoke<PiResources>('pi_list_resources')
      setResources(res)
      setError(null)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  // 挂载拉取；Escape 分层（settings-overlay 同款——overlay=40 层）
  useEffect(() => {
    void load()
    const disposeEscape = pushEscapeLayer(ESCAPE_PRIORITY.overlay)
    return () => disposeEscape()
  }, [])

  const onEscape = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && isTopEscapeLayer(ESCAPE_PRIORITY.overlay)) {
      e.stopPropagation()
      onClose()
    }
  }

  const refresh = () => {
    if (refreshing) return
    setRefreshing(true)
    void load()
  }

  return createPortal(
    <div className="set-overlay" onClick={onClose} onKeyDown={onEscape} role="presentation">
      <div
        aria-label="技能与工具"
        aria-modal="true"
        className="set-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="set-header">
          <h2 className="set-title">技能与工具</h2>
          <div className="set-header-actions">
            <button
              aria-label="刷新"
              className="set-close"
              disabled={refreshing}
              onClick={refresh}
              title="刷新"
              type="button"
            >
              <RefreshCw size={14} />
            </button>
            <button aria-label="关闭" className="set-close" onClick={onClose} type="button">
              <XIcon size={14} />
            </button>
          </div>
        </div>
        {/* 主从两栏（settings-overlay 同构）：左导航三节 + 右内容 */}
        <nav aria-label="资源节" className="set-nav">
          {(
            [
              ['skills', '技能'],
              ['prompts', '提示词模板'],
              ['config', '扩展与配置'],
            ] as const
          ).map(([id, label]) => (
            <button
              aria-current={tab === id ? 'true' : undefined}
              className={tab === id ? 'set-nav-item is-active' : 'set-nav-item'}
              key={id}
              onClick={() => setTab(id)}
              type="button"
            >
              <span className="set-nav-item-label">{label}</span>
            </button>
          ))}
        </nav>
        <div className="set-content">
          {error !== null && <div className="set-err">{error}</div>}
          {loading && error === null && <span className="set-file-missing">加载中…</span>}
          {resources !== null && (
            <>
              {tab === 'skills' && (
                <section className="set-section">
                  <header className="set-section-head">
                    <h3 className="set-section-title">技能（{resources.skills.length}）</h3>
                  </header>
                  <p className="set-hint">
                    技能目录：<span className="set-code">{resources.agentDir}\skills</span>
                    （项目级 .pi/skills 与 settings 的 skills 显式路径一并装载——pi
                    resources.rs 的目录约定）。legacy&nbsp;
                    <span className="set-code">~/.pi/skills</span> 不被 pi 加载。
                  </p>
                  {resources.diagnostics.map((d, i) => (
                    <div className="set-err" key={`diag-${i}`}>
                      {d.kind === 'Collision' ? '碰撞' : '警告'}：{d.message}（{d.path}）
                    </div>
                  ))}
                  {resources.skills.length === 0 && (
                    <span className="set-file-missing">尚无技能——在技能目录放置 SKILL.md 后刷新。</span>
                  )}
                  <div className="set-rows">
                    {resources.skills.map((s) => (
                      <div className="set-row" key={s.path}>
                        <span className="set-row-provider">{s.name}</span>
                        <span className="set-row-source">
                          {s.source}
                          {s.disableModelInvocation ? ' · 不自动调用' : ''}
                        </span>
                        <span className="set-row-desc" title={s.description}>{s.description}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {tab === 'prompts' && (
                <section className="set-section">
                  <header className="set-section-head">
                    <h3 className="set-section-title">提示词模板（{resources.prompts.length}）</h3>
                  </header>
                  <p className="set-hint">
                    模板目录：<span className="set-code">{resources.agentDir}\prompts</span>
                    （settings 的 prompts 显式路径一并装载）。
                  </p>
                  {resources.prompts.length === 0 && (
                    <span className="set-file-missing">尚无提示词模板。</span>
                  )}
                  <div className="set-rows">
                    {resources.prompts.map((p) => (
                      <div className="set-row" key={p.path}>
                        <span className="set-row-provider">{p.name}</span>
                        <span className="set-row-source">{p.source}</span>
                        <span className="set-row-desc" title={p.description}>{p.description}</span>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {tab === 'config' && (
                <section className="set-section">
                  <header className="set-section-head">
                    <h3 className="set-section-title">扩展与配置</h3>
                  </header>
                  <p className="set-hint">
                    以下来自 settings.json 的配置面（pi 起跑时装载；扩展可注册工具
                    与 hostcall）。本宿主未配置 extension_paths——列表即 settings
                    现值。
                  </p>
                  <div className="set-rows">
                    <div className="set-row">
                      <span className="set-row-provider">技能命令</span>
                      {resources.enableSkillCommands === false ? (
                        <span className="set-row-miss">关闭（skills 不注册 / 命令）</span>
                      ) : (
                        <span className="set-row-ok">开启 ✓</span>
                      )}
                    </div>
                    {resources.extensions.map((ext) => (
                      <div className="set-row" key={ext}>
                        <span className="set-row-provider">{ext}</span>
                        <span className="set-row-source">extension</span>
                      </div>
                    ))}
                    {resources.packages.map((pkg) => (
                      <div className="set-row" key={pkg}>
                        <span className="set-row-provider">{pkg}</span>
                        <span className="set-row-source">package</span>
                      </div>
                    ))}
                    {resources.extensions.length === 0 && resources.packages.length === 0 && (
                      <span className="set-file-missing">未配置 extensions / packages。</span>
                    )}
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** 浮层最小开关（app-context-menu.tsx SettingsHost 同款形态）。 */
interface ResourcesDialogState {
  open: boolean
  openDialog(): void
  closeDialog(): void
}

export const resourcesDialogStore = createStore<ResourcesDialogState>((set) => ({
  open: false,
  openDialog: () => set({ open: true }),
  closeDialog: () => set({ open: false }),
}))

export function openResourcesDialog(): void {
  resourcesDialogStore.getState().openDialog()
}

const ResourcesDialogHost = () => {
  const open = useStore(resourcesDialogStore, (s) => s.open)
  if (!open) return null
  return <ResourcesDialog onClose={() => resourcesDialogStore.getState().closeDialog()} />
}

export default ResourcesDialogHost
