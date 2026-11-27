/**
 * 启动页（hermes Setup / Desktop 首次启动的连接选择的宿主对偶）。
 *
 * 第一版范围（2026-11-27 用户定稿「只做启动页和连接管理」）：
 *   · 首次启动（或 `?setup=1` / `mirach:open-startup-gate` 事件）显示；
 *   · 本机启动 = 继续现有本地 Rust 引擎链路，并记住选择；
 *   · 远程连接 = 复用设置页的「连接注册表」（真保存 / 真测试 / 设主要 /
 *     凭据进 OS 凭据管理器）。**远程运行面尚未接入**，所以这里不提供
 *     「远程启动」假按钮——连接先配好、测通，等运行时接上后直接复用这份
 *     注册表与 primary。
 *
 * 启动选择存 localStorage（`mirach.startup.connection.v1`），不是连接凭据；
 * 连接本体仍在 Rust `connections.json` + keyring。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { GlobeIcon, MonitorIcon } from 'lucide-react'

import { ConnectionsRegistrySection } from '@/contrib/mirach-connections/connections-registry'
import { cn } from '@/lib/utils'

const CHOICE_KEY = 'mirach.startup.connection.v1'
const OPEN_EVENT = 'mirach:open-startup-gate'

type StartupChoice = 'local' | 'remote'

function forceOpen(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('setup') === '1'
  } catch {
    return false
  }
}

function readChoice(): StartupChoice | null {
  try {
    const value = window.localStorage.getItem(CHOICE_KEY)
    return value === 'local' || value === 'remote' ? value : null
  } catch {
    return null
  }
}

function writeChoice(choice: StartupChoice): void {
  try {
    window.localStorage.setItem(CHOICE_KEY, choice)
  } catch (e) {
    console.error('[startup] 保存启动选择失败', e)
  }
}

export function StartupConnectionGate() {
  const [open, setOpen] = useState(() => forceOpen() || readChoice() === null)
  const [choice, setChoice] = useState<StartupChoice>(() => readChoice() ?? 'local')

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener(OPEN_EVENT, show)
    return () => window.removeEventListener(OPEN_EVENT, show)
  }, [])

  const close = useCallback((next: StartupChoice) => {
    writeChoice(next)
    setOpen(false)
  }, [])

  const connectionHint = useMemo(
    () =>
      choice === 'remote'
        ? `远程连接已交给下方「连接注册表」：先添加地址/token 并点「测试」。
           运行面（把主窗口切到远端引擎）是下一阶段，本页不会假装已连通。`
        : '本机 = 应用内置的 Rust 引擎，随窗口启动，不需要安装额外运行时。',
    [choice],
  )

  if (!open) return null

  return (
    <div
      aria-labelledby="startup-gate-title"
      aria-modal="true"
      className="startup-gate fixed inset-0 grid place-items-center bg-(--surface-base)/95 p-4 text-foreground backdrop-blur-sm"
      role="dialog"
    >
      <div className="startup-gate__panel w-[min(1080px,94vw)] max-h-[92vh] overflow-y-auto rounded-[var(--radius-panel-lg)] border border-(--stroke-soft) bg-(--surface) p-5 shadow-(--shadow-pane)">
        <div className="flex items-center gap-3">
          <img alt="Mirach" className="size-10 rounded-full object-cover" src="/brand/logo.png" />
          <div className="min-w-0">
            <h1 className="text-[1.05rem] font-semibold" id="startup-gate-title">
              Mirach Harness
            </h1>
            <p className="text-muted-foreground text-xs">选择启动方式 · 连接管理</p>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <button
            aria-pressed={choice === 'local'}
            className={cn(
              'rounded-xl border p-4 text-left transition-colors',
              choice === 'local'
                ? 'border-(--brand) bg-(--brand)/6'
                : 'border-(--stroke-soft) hover:bg-(--hover-wash)',
            )}
            onClick={() => setChoice('local')}
            type="button"
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <MonitorIcon className="size-[var(--size-icon-md)]" />
              本机启动
              <span className="rounded bg-(--brand)/12 px-1.5 py-0.5 text-[0.625rem] font-medium text-(--brand)">
                当前可用
              </span>
            </span>
            <span className="text-muted-foreground mt-2 block text-xs leading-5">
              使用应用内置的 Rust 引擎（pi_agent_rust）在本机运行。会话、技能、扩展、
              终端和文件都在本机。
            </span>
          </button>

          <button
            aria-pressed={choice === 'remote'}
            className={cn(
              'rounded-xl border p-4 text-left transition-colors',
              choice === 'remote'
                ? 'border-(--brand) bg-(--brand)/6'
                : 'border-(--stroke-soft) hover:bg-(--hover-wash)',
            )}
            onClick={() => setChoice('remote')}
            type="button"
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <GlobeIcon className="size-[var(--size-icon-md)]" />
              连接远程
              <span className="rounded bg-(--ui-bg-quaternary) px-1.5 py-0.5 text-[0.625rem] font-medium text-(--ui-text-tertiary)">
                连接管理
              </span>
            </span>
            <span className="text-muted-foreground mt-2 block text-xs leading-5">
              远程 Hermes/Mirach 网关：先在下方注册表保存地址与 token 并测试连接。
              远程运行面（主窗口切到远端引擎）下一阶段接入。
            </span>
          </button>
        </div>

        <p className="text-muted-foreground mt-2 text-xs leading-5">{connectionHint}</p>

        {choice === 'remote' && (
          <div className="mt-4 rounded-xl border border-(--stroke-soft) bg-(--surface-shell) p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold">远程连接</h2>
                <p className="text-muted-foreground text-xs">
                  保存 / 测试远端网关；凭据写 OS 凭据管理器，不明文落盘。
                </p>
              </div>
            </div>
            <ConnectionsRegistrySection />
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-2 border-t border-(--stroke-soft) pt-4">
          <p className="text-muted-foreground text-xs">
            {choice === 'remote'
              ? '远程运行面尚未接入：本次仍可用「本机启动」进入应用；连接配置会保留。'
              : '选择会记住，下次启动直接进入；可从设置「网关连接」重新打开本页。'}
          </p>
          <div className="flex items-center gap-2">
            <button className="set-btn" onClick={() => close('local')} type="button">
              {choice === 'remote' ? '先本机启动' : '稍后'}
            </button>
            <button className="set-btn set-btn-primary" onClick={() => close('local')} type="button">
              本机启动
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
