/**
 * 设置 → 技能与工具（2026-11-25 用户："内容全部换成本地的开关"）。
 *
 * 数据面 = 宿主自己的能力偏好（`~/.rpi/agent/harness-capabilities.json`），
 * 与左栏「技能与工具」页同一个 `pi_capabilities` 真值：
 *   · 工具集 17 组 —— `pi_set_toolset_enabled`
 *   · 技能清单 —— `pi_set_skill_enabled`
 * 不再展示 rpi settings.json 的 skillDirs / promptDirs / extensionDirs /
 * defaultTools 文本框（那些属于引擎原始配置，仍可在「安全 → 原始配置」里改）。
 * 开关只影响新会话：现有会话的系统提示/工具集在创建时已定（引擎语义）。
 */
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

import { Switch } from '@/components/ui/switch'

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

function describeIpcError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function CapabilityRow({
  label,
  desc,
  meta,
  checked,
  disabled,
  onChange,
}: {
  label: string
  desc: string
  meta?: string
  checked: boolean
  disabled: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <div className="set-acct-field">
      <div className="set-acct-field-text">
        <span className="set-acct-field-label">{label}</span>
        <p className="set-acct-field-desc">{desc}</p>
        {meta !== undefined && <p className="set-hint">{meta}</p>}
      </div>
      <div className="set-acct-field-control">
        <Switch
          aria-label={label}
          checked={checked}
          disabled={disabled}
          onCheckedChange={onChange}
        />
      </div>
    </div>
  )
}

export function SkillsToolsSettings() {
  const [snapshot, setSnapshot] = useState<CapabilitiesSnapshot | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    return invoke<CapabilitiesSnapshot>('pi_capabilities')
      .then((next) => {
        setSnapshot(next)
        setLoadError(null)
      })
      .catch((e: unknown) => {
        console.error('[capabilities] 读取失败', e)
        setLoadError(describeIpcError(e))
      })
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
        setActionError(`${row.label}：${describeIpcError(e)}`)
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
        setActionError(`${row.name}：${describeIpcError(e)}`)
      })
      .finally(() => setBusy(null))
  }

  return (
    <section className="set-section">
      <p className="set-hint">
        开关保存在本机 <span className="set-code">harness-capabilities.json</span>
        ，与左栏「技能与工具」页同源；只影响新建会话（现有会话的工具集/系统
        提示在创建时已确定）。
      </p>
      {loadError !== null && (
        <div className="set-err">能力清单读取失败：{loadError}</div>
      )}
      {actionError !== null && <div className="set-err">{actionError}</div>}
      {snapshot === null && loadError === null && (
        <span className="set-file-missing">加载中…</span>
      )}

      {snapshot !== null && (
        <>
          <h4 className="set-sub-title">工具集</h4>
          <div className="set-acct-card">
            <div className="set-acct-card-body">
              {snapshot.toolsets.map((row) => (
                <CapabilityRow
                  checked={row.enabled}
                  desc={row.description}
                  disabled={busy === `toolset:${row.key}`}
                  key={row.key}
                  label={row.label}
                  meta={
                    `${row.tools.length} 个工具` +
                    (row.needsSetup ? ' · 需要引擎配置后才真正可用' : '')
                  }
                  onChange={(on) => toggleToolset(row, on)}
                />
              ))}
            </div>
          </div>

          <h4 className="set-sub-title">技能</h4>
          <div className="set-acct-card">
            <div className="set-acct-card-body">
              {snapshot.skills.length === 0 && (
                <div className="set-acct-field">
                  <div className="set-acct-field-text">
                    <span className="set-acct-field-label">尚未发现技能</span>
                    <p className="set-acct-field-desc">
                      技能目录：<span className="set-code">{snapshot.skillsDir}</span>
                    </p>
                  </div>
                </div>
              )}
              {snapshot.skills.map((row) => (
                <CapabilityRow
                  checked={row.enabled}
                  desc={row.description || '（无描述）'}
                  disabled={busy === `skill:${row.name}`}
                  key={row.name}
                  label={row.name}
                  meta={
                    (row.source === 'project' ? '项目技能' : '全局技能') +
                    (row.disableModelInvocation ? ' · 仅手动调用' : '')
                  }
                  onChange={(on) => toggleSkill(row, on)}
                />
              ))}
            </div>
          </div>

          {snapshot.diagnostics.length > 0 && (
            <>
              <h4 className="set-sub-title">加载诊断</h4>
              <div className="set-acct-card">
                <div className="set-acct-card-body">
                  {snapshot.diagnostics.map((d, i) => (
                    <div className="set-acct-field" key={`${d.kind}-${i}`}>
                      <div className="set-acct-field-text">
                        <span className="set-acct-field-label">{d.kind}</span>
                        <p className="set-acct-field-desc">{d.message}</p>
                        {d.path !== undefined && (
                          <p className="set-hint">
                            <span className="set-code">{d.path}</span>
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
