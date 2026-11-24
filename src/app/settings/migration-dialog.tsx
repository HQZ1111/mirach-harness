/**
 * 迁移数据（ZCode OnboardingDialog 的宿主可执行子集）。
 *
 * ZCode 的迁移向导从 Claude Code 迁移：会话 / Skills / MCP 服务器 / 命令 /
 * CLAUDE.md → AGENTS.md。宿主可落地：Skills（目录复制）、MCP（合并进 mcp.json）、
 * CLAUDE.md → SYSTEM.md；Claude 会话无导入器（pi 无 session.foreign.*），命令
 * 无消费面——这两类如实标注，不假装能导入。
 *
 * UI 结构照 ZCode：左侧步骤栏（会话 / Skills / MCP 服务器 / 命令 / AGENTS.md /
 * 迁移）+ 标题/描述 + 选中列表 + 底部「取消 / 上一步 / 下一步 / 开始迁移」。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, LoaderCircle, X } from 'lucide-react'

import { invoke } from '@tauri-apps/api/core'

interface MigrationScan {
  sessions: {
    count: number
    sessions: { path: string; workspace: string; title?: string | null; messageCount: number }[]
    workspaces: string[]
    supported: boolean
    reason: string
  }
  skills: { name: string; path: string }[]
  mcp: { name: string }[]
  commands: { name: string; path: string }[]
  commandsSupported: boolean
  commandsReason: string
  agentsFile: { source: string; target: string; exists: boolean }
}

interface MigrationResult {
  imported: { skills: string[]; mcp: string[]; agentsFile: boolean }
  skipped: { skills: string[] }
  failed: { kind: string; name: string; error: string }[]
}

const STEPS = [
  { key: 'session', label: '会话', description: '查看检测结果，选择要迁移的会话与工作区。' },
  { key: 'skills', label: 'Skills', description: '在最终迁移前，从外部 Agent 选择要导入的 Skills。' },
  { key: 'mcp', label: 'MCP 服务器', description: '从外部 Agent 配置中选择要合并的 MCP 服务器。' },
  { key: 'commands', label: '命令', description: '在最终迁移前，从外部 Agent 选择要导入的命令。' },
  { key: 'agents', label: 'AGENTS.md', description: '' },
  { key: 'migration', label: '迁移', description: '开始迁移并等待完成导入。' },
] as const

type StepKey = (typeof STEPS)[number]['key']

export function MigrationDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<StepKey>('session')
  const [scan, setScan] = useState<MigrationScan | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [selectedSkills, setSelectedSkills] = useState<ReadonlySet<string>>(new Set())
  const [selectedMcp, setSelectedMcp] = useState<ReadonlySet<string>>(new Set())
  const [selectedSessions, setSelectedSessions] = useState<ReadonlySet<string>>(new Set())
  const [agentsFile, setAgentsFile] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<MigrationResult | null>(null)
  const [sessionResult, setSessionResult] = useState<{
    imported: { path: string; sessionId: string; title?: string | null; messageCount: number }[]
    failed: { path: string; error: string }[]
  } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => {
    void invoke<MigrationScan>('pi_migration_scan')
      .then((data) => {
        setScan(data)
        setAgentsFile(data.agentsFile.exists)
      })
      .catch((e) => {
        console.error('[migration] 扫描失败', e)
        setScanError(e instanceof Error ? e.message : String(e))
      })
  }, [])

  const stepIndex = STEPS.findIndex((s) => s.key === step)
  const current = STEPS[stepIndex] ?? STEPS[0]

  const toggle = (
    setter: React.Dispatch<React.SetStateAction<ReadonlySet<string>>>,
    name: string,
  ) => {
    setter((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const canBegin =
    selectedSessions.size > 0 || selectedSkills.size > 0 || selectedMcp.size > 0 || agentsFile

  const runImport = useCallback(async () => {
    setBusy(true)
    setImportError(null)
    setResult(null)
    setSessionResult(null)
    try {
      if (selectedSessions.size > 0) {
        const sessionImported = await invoke<{
          imported: { path: string; sessionId: string; title?: string | null; messageCount: number }[]
          failed: { path: string; error: string }[]
        }>('pi_migration_import_sessions', { paths: [...selectedSessions] })
        setSessionResult(sessionImported)
      }
      const imported = await invoke<MigrationResult>('pi_migration_import', {
        skills: [...selectedSkills],
        mcp: [...selectedMcp],
        agentsFile,
      })
      setResult(imported)
    } catch (e) {
      console.error('[migration] 导入失败', e)
      setImportError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [agentsFile, selectedMcp, selectedSessions, selectedSkills])

  const body = useMemo(() => {
    if (scanError !== null) {
      return <div className="set-err">扫描失败：{scanError}</div>
    }
    if (scan === null) {
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" /> 正在扫描 Claude Code 配置…
        </p>
      )
    }
    if (step === 'session') {
      return (
        <div className="space-y-3">
          {scan.sessions.sessions.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              暂无可迁移工作区。请先扫描本地历史，再勾选要迁移的工作区。
            </p>
          ) : (
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {scan.sessions.sessions.map((row) => (
                <label
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                  key={row.path}
                >
                  <input
                    checked={selectedSessions.has(row.path)}
                    onChange={() => toggle(setSelectedSessions, row.path)}
                    type="checkbox"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{row.title ?? row.path.split(/[\\/]/).pop()}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {row.workspace} · {row.messageCount} 条消息
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>
      )
    }
    if (step === 'skills') {
      return scan.skills.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无可导入项。</p>
      ) : (
        <div className="space-y-1">
          {scan.skills.map((skill) => (
            <label
              className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
              key={skill.name}
            >
              <input
                checked={selectedSkills.has(skill.name)}
                onChange={() => toggle(setSelectedSkills, skill.name)}
                type="checkbox"
              />
              <span className="min-w-0 flex-1 truncate">{skill.name}</span>
              <span className="max-w-[45%] truncate text-xs text-muted-foreground" title={skill.path}>
                {skill.path}
              </span>
            </label>
          ))}
        </div>
      )
    }
    if (step === 'mcp') {
      return scan.mcp.length === 0 ? (
        <p className="text-sm text-muted-foreground">暂无可导入项。</p>
      ) : (
        <div className="space-y-1">
          {scan.mcp.map((server) => (
            <label
              className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
              key={server.name}
            >
              <input
                checked={selectedMcp.has(server.name)}
                onChange={() => toggle(setSelectedMcp, server.name)}
                type="checkbox"
              />
              <span className="min-w-0 flex-1 truncate">{server.name}</span>
            </label>
          ))}
        </div>
      )
    }
    if (step === 'commands') {
      return (
        <div className="space-y-3">
          {scan.commands.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无可导入项。</p>
          ) : (
            <div className="space-y-1">
              {scan.commands.map((command) => (
                <label
                  className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm opacity-60"
                  key={command.name}
                >
                  <input disabled type="checkbox" />
                  <span className="min-w-0 flex-1 truncate">{command.name}</span>
                </label>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{scan.commandsReason}</p>
        </div>
      )
    }
    if (step === 'agents') {
      return (
        <div className="space-y-3">
          {!scan.agentsFile.exists ? (
            <p className="text-sm text-muted-foreground">
              未找到 ~/.claude/CLAUDE.md，无法迁移 Claude 用户记忆。
            </p>
          ) : (
            <>
              <label className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                <input
                  checked={agentsFile}
                  onChange={(e) => setAgentsFile(e.target.checked)}
                  type="checkbox"
                />
                复制 CLAUDE.md 到 SYSTEM.md
              </label>
              <div className="space-y-1 text-xs text-muted-foreground">
                <div>来源：<span className="font-mono">{scan.agentsFile.source}</span></div>
                <div>目标：<span className="font-mono">{scan.agentsFile.target}</span></div>
              </div>
            </>
          )}
        </div>
      )
    }
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          将迁移：会话 {selectedSessions.size} 个 · Skills {selectedSkills.size} 项 · MCP{' '}
          {selectedMcp.size} 项
          {agentsFile ? ' · CLAUDE.md → SYSTEM.md' : ''}
        </p>
        {sessionResult !== null && (
          <div className="space-y-1 text-sm">
            <div className="text-[var(--fl-accent)]">
              已导入会话 {sessionResult.imported.length} 个
            </div>
            {sessionResult.imported.slice(0, 5).map((row) => (
              <div className="text-muted-foreground" key={row.path}>
                {row.title ?? row.sessionId} · {row.messageCount} 条消息
              </div>
            ))}
            {sessionResult.failed.map((row) => (
              <div className="set-err" key={row.path}>
                {row.path}：{row.error}
              </div>
            ))}
          </div>
        )}
        {result !== null && (
          <div className="space-y-1 text-sm">
            <div className="text-[var(--fl-accent)]">
              已导入：Skills {result.imported.skills.length} · MCP {result.imported.mcp.length}
              {result.imported.agentsFile ? ' · SYSTEM.md' : ''}
            </div>
            {result.skipped.skills.length > 0 && (
              <div className="text-muted-foreground">
                已跳过（同名存在）：{result.skipped.skills.join('、')}
              </div>
            )}
            {result.failed.map((row) => (
              <div className="set-err" key={`${row.kind}:${row.name}`}>
                {row.name}：{row.error}
              </div>
            ))}
          </div>
        )}
        {importError !== null && <div className="set-err">导入失败：{importError}</div>}
      </div>
    )
  }, [agentsFile, importError, result, scan, scanError, selectedMcp, selectedSessions, selectedSkills, sessionResult, step])

  return (
    <div
      style={{
        alignItems: 'center',
        background: 'rgba(0,0,0,0.35)',
        display: 'flex',
        inset: 0,
        justifyContent: 'center',
        position: 'fixed',
        zIndex: 60,
      }}
    >
      <div
        style={{
          background: 'var(--surface)',
          borderRadius: 16,
          boxShadow: '0 20px 60px rgba(0, 0, 0, 0.25)',
          display: 'flex',
          height: 560,
          overflow: 'hidden',
          width: 'min(860px, calc(100vw - 40px))',
        }}
      >
        <nav
          className="flex shrink-0 flex-col gap-1"
          style={{ borderRight: '1px solid var(--stroke-soft)', padding: 16, width: 180 }}
        >
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            迁移向导
          </div>
          {STEPS.map((item) => (
            <button
              className="rounded-md px-2 py-1.5 text-left text-sm"
              key={item.key}
              onClick={() => setStep(item.key)}
              style={{ background: step === item.key ? 'var(--hover-wash)' : undefined }}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4" style={{ padding: 20 }}>
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg font-semibold text-foreground">{current.label}</div>
                {current.description !== '' && (
                  <p className="mt-1 text-sm text-muted-foreground">{current.description}</p>
                )}
              </div>
              <button
                aria-label="关闭"
                className="rounded-md p-1 text-muted-foreground hover:text-foreground"
                onClick={onClose}
                type="button"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
            <div className="flex items-center justify-between border-t border-border pt-3">
              <span className="text-xs text-muted-foreground">
                可随时跳过引导，稍后在设置中继续迁移。
              </span>
              <div className="flex gap-2">
                <button className="set-btn" onClick={onClose} type="button">
                  取消
                </button>
                {stepIndex > 0 && (
                  <button
                    className="set-btn"
                    onClick={() => setStep(STEPS[stepIndex - 1]!.key)}
                    type="button"
                  >
                    上一步
                  </button>
                )}
                {step !== 'migration' ? (
                  <button
                    className="set-btn set-btn-primary"
                    onClick={() => setStep(STEPS[stepIndex + 1]!.key)}
                    type="button"
                  >
                    下一步
                  </button>
                ) : (
                  <button
                    className="set-btn set-btn-primary"
                    disabled={busy || !canBegin}
                    onClick={() => void runImport()}
                    style={{ background: '#111', color: '#fff' }}
                    type="button"
                  >
                    {busy ? '迁移中…' : result !== null ? '再次迁移' : '开始迁移'}
                  </button>
                )}
              </div>
            </div>
          </div>
      </div>
    </div>
  )
}
