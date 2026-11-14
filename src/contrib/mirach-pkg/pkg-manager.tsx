/**
 * 包管理页——pi `install/remove/update/list` 的图形化（全真实数据面
 * pi_pkg.rs）。列表 = settings.json 的 packages 数组（全局 + 项目两 scope，
 * PackageManager::list_packages_blocking 投影）；安装/移除/更新直调 IPC。
 * npm/git 子进程跑在大栈线程，UI 显示 loading 态。
 */
import { useEffect, useState, type FC } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { PackageIcon, PlusIcon, RefreshCwIcon, TrashIcon, Loader2Icon } from 'lucide-react'
import { cn } from '@/lib/utils'

interface PkgEntry {
  scope: 'user' | 'project' | 'temporary'
  source: string
  filter: {
    extensions?: null | string[]
    skills?: null | string[]
    prompts?: null | string[]
    themes?: null | string[]
  } | null
}

const SCOPE_LABELS: Record<PkgEntry['scope'], string> = {
  user: '全局',
  project: '项目',
  temporary: '临时',
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
      setError(String(e).slice(0, 240))
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
      setError(String(e).slice(0, 240))
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
        <label className="set-field-label" htmlFor="pkg-source">安装包（npm:pkg / git:url / 本地路径）</label>
        <div className="set-field-control">
          <input
            className="set-input"
            id="pkg-source"
            onChange={(e) => setSource(e.target.value)}
            placeholder="npm:pi-ext-example 或 git:owner/repo"
            value={source}
          />
          <select
            className="set-select"
            onChange={(e) => setScope(e.target.value as 'user' | 'project')}
            value={scope}
          >
            <option value="user">全局（settings.json）</option>
            <option value="project">项目（.pi/settings.json）</option>
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
          安装 = pi install（npm/git/本地路径）；源列表同步落对应 settings.json（上游
          add_package_source 通道）。npm/git 子进程跑在大栈线程，安装期间 UI 显示 loading。
        </p>
      </div>
      <div className="flex flex-col gap-1">
        {packages.length === 0 ? (
          <div className="text-muted-foreground px-1 py-3 text-center text-xs">
            尚无包——上方输入 source 安装。
          </div>
        ) : (
          packages.map((pkg) => (
            <div
              className="border-border/70 flex items-center gap-2 rounded-lg border px-2.5 py-2"
              key={`${pkg.scope}:${pkg.source}`}
            >
              <PackageIcon className="text-muted-foreground size-[var(--size-icon-md)] shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-foreground truncate text-[0.8125rem] font-medium">{pkg.source}</span>
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
                </div>
                {pkg.filter && (
                  <div className="text-muted-foreground truncate text-xs">
                    {(
                      [
                        ['extensions', pkg.filter.extensions],
                        ['skills', pkg.filter.skills],
                        ['prompts', pkg.filter.prompts],
                        ['themes', pkg.filter.themes],
                      ] as const
                    )
                      .filter(([, v]) => v && v.length > 0)
                      .map(([k, v]) => `${k}:${(v as string[]).length}`)
                      .join(' · ') || '全部资源'}
                  </div>
                )}
              </div>
              <button
                aria-label={`更新 ${pkg.source}`}
                className="text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors"
                disabled={busy !== null}
                onClick={() => void run('update', pkg.source, pkg.scope)}
                title="更新"
                type="button"
              >
                {busy === `update:${pkg.source}` ? (
                  <Loader2Icon className="size-[var(--size-icon-sm)] animate-spin" />
                ) : (
                  <RefreshCwIcon className="size-[var(--size-icon-sm)]" />
                )}
              </button>
              <button
                aria-label={`移除 ${pkg.source}`}
                className="text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors"
                disabled={busy !== null}
                onClick={() => void run('remove', pkg.source, pkg.scope)}
                title="移除"
                type="button"
              >
                <TrashIcon className="size-[var(--size-icon-sm)]" />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
