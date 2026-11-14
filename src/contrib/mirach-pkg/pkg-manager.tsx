/**
 * 包管理页——rpi 包登记表的图形化（全真实数据面 pi_pkg.rs）。
 *
 * 列表 = 两张登记表的只读投影：
 * - 全局原生扩展：`~/.rpi/agent/native-packages.json`（`rpi install` 写）
 * - 项目包：`<cwd>/.rpi/packages.json`（`rpi packages link` 写）
 *
 * 安装/卸载/更新是引擎侧 CLI 的事（`rpi install` / `rpi uninstall` /
 * `rpi extension update`）：宿主只读，按钮保留是为了把 IPC 返回的准确
 * 指引显示出来（不静默、不假装成功）。
 */
import { useEffect, useState, type FC } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { PackageIcon, PlusIcon, RefreshCwIcon, TrashIcon, Loader2Icon } from 'lucide-react'
import { cn } from '@/lib/utils'

interface PkgEntry {
  /** user = 全局原生扩展；project = .rpi/packages.json */
  scope: 'user' | 'project'
  kind: 'native' | 'project'
  name: string
  version: string
  /** 来源/出处（cargo registry 构建没有 source → null）。 */
  source: string | null
  repository: string | null
  target: string | null
  abi: number | null
  cargoPackage: string | null
  artifacts: string[]
  /** 登记了但磁盘上不存在的产物（非空 = 安装不完整）。 */
  missingArtifacts: string[]
}

const SCOPE_LABELS: Record<PkgEntry['scope'], string> = {
  user: '全局',
  project: '项目',
}

export const PkgManagerSection: FC = () => {
  const [packages, setPackages] = useState<readonly PkgEntry[]>([])
  const [source, setSource] = useState('')
  const [scope, setScope] = useState<'user' | 'project'>('user')
  const [busy, setBusy] = useState<null | string>(null)
  const [error, setError] = useState<string | null>(null)

  const load = async () => {
    try {
      const result = await invoke<{ packages: PkgEntry[] }>('pi_pkg_list', { cwd: null })
      setPackages(result.packages)
      setError(null)
    } catch (e) {
      setError(String(e).slice(0, 480))
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const run = async (action: 'install' | 'remove' | 'update', pkgSource: string, pkgScope: string) => {
    setBusy(`${action}:${pkgSource}`)
    setError(null)
    try {
      const result = await invoke<{ packages: PkgEntry[] }>(`pi_pkg_${action}`, {
        cwd: null,
        source: pkgSource,
        scope: pkgScope,
      })
      setPackages(result.packages)
    } catch (e) {
      setError(String(e).slice(0, 480))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="flex flex-col gap-2" data-slot="pkg-manager">
      <div className="flex items-center justify-between">
        <h3 className="text-foreground text-sm font-semibold">包</h3>
        <button className="set-btn" onClick={() => void load()} type="button">
          <RefreshCwIcon className="mr-1 inline size-[var(--size-icon-sm)]" />
          刷新
        </button>
      </div>
      {error && <div className="set-err">{error}</div>}
      <div className="set-field">
        <label className="set-field-label" htmlFor="pkg-source">安装包（引擎侧命令执行）</label>
        <div className="set-field-control">
          <input
            className="set-input"
            id="pkg-source"
            onChange={(e) => setSource(e.target.value)}
            placeholder={scope === 'user' ? 'crate 名，如 rpi-todo' : '扩展源码目录，如 .'}
            value={source}
          />
          <select
            className="set-select"
            onChange={(e) => setScope(e.target.value as 'user' | 'project')}
            value={scope}
          >
            <option value="user">全局（rpi install）</option>
            <option value="project">项目（rpi package link）</option>
          </select>
          <button
            className="set-btn set-btn-primary pressable"
            disabled={!source.trim() || busy !== null}
            onClick={() => void run('install', source.trim(), scope)}
            type="button"
          >
            <PlusIcon className="mr-1 inline size-[var(--size-icon-sm)]" />
            安装
          </button>
        </div>
        <p className="set-hint">
          宿主只读列表：安装/卸载/更新由 rpi 引擎侧 CLI 执行（预编译件下载、cargo
          构建、sha256 校验、登记表事务都在 rpi-cli 里）。点按钮会显示应执行的命令
          （rpi install / rpi package link / rpi uninstall / rpi package unlink），
          不代跑外部进程。
        </p>
      </div>
      <div className="flex flex-col gap-1">
        {packages.length === 0 ? (
          <div className="text-muted-foreground px-1 py-3 text-center text-xs">
            尚无包——引擎侧 `rpi install &lt;crate&gt;` 安装后刷新。
          </div>
        ) : (
          packages.map((pkg) => {
            const provenance = pkg.repository ?? pkg.source ?? 'cargo registry'
            const incomplete = pkg.missingArtifacts.length > 0
            return (
              <div
                className="border-border/70 flex items-center gap-2 rounded-lg border px-2.5 py-2"
                key={`${pkg.scope}:${pkg.kind}:${pkg.name}`}
              >
                <PackageIcon className="text-muted-foreground size-[var(--size-icon-md)] shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-foreground truncate text-[0.8125rem] font-medium">
                      {pkg.name}
                    </span>
                    {pkg.version && (
                      <span className="text-muted-foreground shrink-0 text-[0.6875rem]">
                        {pkg.version}
                      </span>
                    )}
                    <span
                      className={cn(
                        'rounded px-1 py-0.5 text-[0.625rem]',
                        pkg.scope === 'user'
                          ? 'bg-(--color-brand)/15 text-(--color-brand)'
                          : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {SCOPE_LABELS[pkg.scope]}
                    </span>
                    {pkg.abi !== null && (
                      <span className="text-muted-foreground text-[0.625rem]">ABI {pkg.abi}</span>
                    )}
                  </div>
                  <div className="text-muted-foreground truncate text-xs">
                    {provenance}
                    {pkg.target ? ` · ${pkg.target}` : ''}
                    {pkg.cargoPackage ? ` · cargo:${pkg.cargoPackage}` : ''}
                    {` · 产物 ${pkg.artifacts.length}`}
                  </div>
                  {incomplete && (
                    <div className="text-destructive truncate text-xs">
                      产物缺失：{pkg.missingArtifacts.join(', ')}
                    </div>
                  )}
                </div>
                <button
                  aria-label={`更新 ${pkg.name}`}
                  className="text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors"
                  disabled={busy !== null}
                  onClick={() => void run('update', pkg.name, pkg.scope)}
                  title="更新（引擎侧 rpi extension update）"
                  type="button"
                >
                  {busy === `update:${pkg.name}` ? (
                    <Loader2Icon className="size-[var(--size-icon-sm)] animate-spin" />
                  ) : (
                    <RefreshCwIcon className="size-[var(--size-icon-sm)]" />
                  )}
                </button>
                <button
                  aria-label={`移除 ${pkg.name}`}
                  className="text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors"
                  disabled={busy !== null}
                  onClick={() => void run('remove', pkg.name, pkg.scope)}
                  title={
                    pkg.scope === 'user'
                      ? '移除（引擎侧 rpi uninstall）'
                      : '移除（引擎侧 rpi package unlink）'
                  }
                  type="button"
                >
                  <TrashIcon className="size-[var(--size-icon-sm)]" />
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
