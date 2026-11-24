/**
 * 设置页「数据与统计 → 数据同步」（2026-11-23 四版：照 ZCode 的远程设备模型）。
 *
 * ZCode 的数据同步设备 = **SSH / WSL / Docker 远程工作区**（不是网关连接）：
 * - 页面：标题 +「同步本机配置到远端。」+ ⓘ 同步规则 + 右上「迁移数据」；
 *   空态 = 虚线卡 +「暂无已连接设备」+「连接远程设备」；
 * - 新建连接对话框 = 标题「新建连接」+ SSH/WSL/Docker 三档 + 发行版/用户
 *   （WSL）或容器（Docker）或主机/用户/密钥（SSH）+「取消 / 添加并连接」；
 * - 设备行 = 名称 + 目标描述 + 上次同步 +「同步配置」。
 *
 * 数据面 = pi_sync.rs：设备存 `~/.rpi/agent/data-sync-devices.json`；
 * 探测 WSL 发行版走 `wsl.exe -l -q`，Docker 容器走 `docker ps`；
 * 推送 = 本机 tar.exe 打包 skills/extensions/mcp.json → 远端 `tar -xzf -`
 * 解包到 `~/.rpi/agent`（ZCode 推送到 ~/.zcode 的宿主对偶）。
 *
 * 「迁移数据」= ZCode 的迁移向导入口；宿主没有其他 AI 工具导入器，按钮禁用
 * 并写明原因（不造假入口）。
 */
import { useCallback, useEffect, useMemo, useState, type FC } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  ArrowRightLeft,
  BoxIcon,
  CheckCircle2,
  HelpCircle,
  ServerIcon,
  TerminalIcon,
  X,
} from 'lucide-react'

import { formatSyncTime } from '@/lib/data-sync-summary'
import { MigrationDialog } from '@/app/settings/migration-dialog'

type DeviceKind = 'ssh' | 'wsl' | 'docker'

interface SyncDevice {
  id: string
  kind: DeviceKind
  kindLabel: string
  label: string
  endpoint: string
  distro?: string | null
  linuxUser?: string | null
  container?: string | null
}

interface SyncCategory {
  key: string
  label: string
  count: number
  items?: string[]
  supported: boolean
}

interface WslProbe {
  available: boolean
  distros: string[]
  error?: string
}

interface DockerProbe {
  available: boolean
  containers: { name: string; image: string }[]
  error?: string
}

interface LastSync {
  at: number
  transferred: string[]
  bytes: number
}

type LastSyncMap = Record<string, LastSync>

const LAST_SYNC_KEY = 'mirach:data-sync:last.v2'

const loadLastSync = (): LastSyncMap => {
  try {
    const raw = localStorage.getItem(LAST_SYNC_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as LastSyncMap
  } catch (e) {
    console.error('[data-sync] 上次同步记录解析失败（按空表显示）', e)
    return {}
  }
}

const persistLastSync = (map: LastSyncMap): void => {
  try {
    localStorage.setItem(LAST_SYNC_KEY, JSON.stringify(map))
  } catch (e) {
    console.error('[data-sync] 上次同步记录写入失败', e)
  }
}

const KIND_ICONS: Record<DeviceKind, typeof ServerIcon> = {
  ssh: ServerIcon,
  wsl: TerminalIcon,
  docker: BoxIcon,
}

const kindLabel = (kind: DeviceKind): string =>
  kind === 'ssh' ? 'SSH' : kind === 'wsl' ? 'WSL' : 'Docker'

export const DataSyncSettings: FC = () => {
  const [devices, setDevices] = useState<SyncDevice[]>([])
  const [categories, setCategories] = useState<SyncCategory[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [rulesOpen, setRulesOpen] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [migrationOpen, setMigrationOpen] = useState(false)
  const [dialogDevice, setDialogDevice] = useState<SyncDevice | null>(null)
  const [lastSync, setLastSync] = useState<LastSyncMap>(() => loadLastSync())

  const reload = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const [deviceResult, manifestResult] = await Promise.all([
        invoke<{ devices: SyncDevice[] }>('pi_sync_devices'),
        invoke<{ categories: SyncCategory[] }>('pi_sync_manifest'),
      ])
      setDevices(deviceResult.devices)
      setCategories(manifestResult.categories)
    } catch (e) {
      console.error('[data-sync] 设备/清单读取失败', e)
      setLoadError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const onSynced = useCallback(
    (deviceId: string, transferred: string[], bytes: number) => {
      const next: LastSyncMap = {
        ...lastSync,
        [deviceId]: { at: Date.now(), transferred, bytes },
      }
      setLastSync(next)
      persistLastSync(next)
    },
    [lastSync],
  )

  return (
    <section className="set-section">
      <div className="set-actions" style={{ alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <p className="set-hint" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
            同步本机配置到远端。
            <button
              aria-label="同步规则"
              className="set-btn"
              onClick={() => setRulesOpen((v) => !v)}
              style={{ height: 20, padding: '0 4px' }}
              title="同步规则"
              type="button"
            >
              <HelpCircle aria-hidden className="size-[var(--size-icon-sm)]" />
            </button>
          </p>
          {rulesOpen && (
            <p className="set-hint" style={{ margin: '4px 0 0' }}>
              同步规则：仅新增或更新，保留远端独有内容。
            </p>
          )}
        </div>
        <button
          className="set-btn"
          onClick={() => setMigrationOpen(true)}
          style={{ whiteSpace: 'nowrap' }}
          title="从 Claude Code 迁移 Skills / MCP / CLAUDE.md"
          type="button"
        >
          <ArrowRightLeft aria-hidden className="inline size-3.5" /> 迁移数据
        </button>
      </div>

      {loadError !== null && <div className="set-err">设备列表读取失败：{loadError}</div>}
      {loading && devices.length === 0 && <span className="set-file-missing">加载中…</span>}

      {!loading && loadError === null && devices.length === 0 && (
        <div
          style={{
            border: '1px dashed var(--stroke)',
            borderRadius: 'var(--radius-control)',
            padding: '48px 24px',
            textAlign: 'center',
          }}
        >
          <ServerIcon aria-hidden className="mx-auto text-[var(--text-4)]" style={{ width: 32, height: 32 }} />
          <div className="set-acct-field-label" style={{ marginTop: 12 }}>
            暂无已连接设备
          </div>
          <p className="set-hint" style={{ maxWidth: 460, margin: '4px auto 0' }}>
            连接 SSH、WSL 或 Docker 设备后，可以把本机配置推送到该设备的 ~/.rpi/agent 目录。
          </p>
          <button
            className="set-btn set-btn-primary"
            onClick={() => setNewOpen(true)}
            style={{ marginTop: 16, whiteSpace: 'nowrap' }}
            type="button"
          >
            连接远程设备
          </button>
        </div>
      )}

      {devices.length > 0 && (
        <div className="set-acct-card">
          <div className="set-acct-card-body" style={{ gap: 0, padding: 0 }}>
            {devices.map((device, index) => {
              const Icon = KIND_ICONS[device.kind] ?? ServerIcon
              const last = lastSync[device.id]
              return (
                <div
                  key={device.id}
                  style={{
                    alignItems: 'center',
                    borderTop: index > 0 ? '1px solid var(--stroke-soft)' : undefined,
                    display: 'grid',
                    gap: 12,
                    gridTemplateColumns: 'minmax(0,1fr) auto auto',
                    padding: '16px',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div className="set-acct-field-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <Icon aria-hidden className="size-[var(--size-icon-sm)]" />
                      {device.label}
                    </div>
                    <div className="set-hint" style={{ margin: '2px 0 0', fontSize: 'var(--font-sm)' }}>
                      {kindLabel(device.kind)} · {device.endpoint}
                    </div>
                  </div>
                  <div style={{ minWidth: 130, fontSize: 'var(--font-sm)' }}>
                    <div className="set-row-source">
                      {last === undefined ? '尚未同步' : `${formatSyncTime(last.at)} 已同步`}
                    </div>
                    {last !== undefined && (
                      <div className="set-row-source" style={{ marginTop: 2 }}>
                        {last.transferred.join(' / ')} · {(last.bytes / 1024).toFixed(1)} KB
                      </div>
                    )}
                  </div>
                  <button
                    className="set-btn set-btn-primary"
                    onClick={() => setDialogDevice(device)}
                    style={{ minWidth: 96, whiteSpace: 'nowrap' }}
                    type="button"
                  >
                    同步配置
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {newOpen && (
        <NewConnectionDialog
          onClose={() => {
            setNewOpen(false)
            void reload()
          }}
          onCreated={() => {
            setNewOpen(false)
            void reload()
          }}
        />
      )}

      {migrationOpen && <MigrationDialog onClose={() => setMigrationOpen(false)} />}

      {dialogDevice !== null && (
        <SyncDialog
          categories={categories}
          device={dialogDevice}
          onClose={() => setDialogDevice(null)}
          onSynced={(transferred, bytes) => onSynced(dialogDevice.id, transferred, bytes)}
        />
      )}
    </section>
  )
}

/** ZCode「新建连接」对话框（RemoteConnectionFields 的 SSH/WSL/Docker 宿主版）。 */
function NewConnectionDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [kind, setKind] = useState<DeviceKind>('ssh')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [user, setUser] = useState('')
  const [authMethod, setAuthMethod] = useState<'password' | 'privateKey'>('password')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [keyPath, setKeyPath] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [showPassphrase, setShowPassphrase] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [assetInstallMode, setAssetInstallMode] = useState<'local-download-upload' | 'remote-download'>(
    'local-download-upload',
  )
  const [distro, setDistro] = useState('')
  const [linuxUser, setLinuxUser] = useState('')
  const [dockerMode, setDockerMode] = useState<'select' | 'manual'>('select')
  const [container, setContainer] = useState('')

  const [wslProbe, setWslProbe] = useState<WslProbe | null>(null)
  const [dockerProbe, setDockerProbe] = useState<DockerProbe | null>(null)
  const [sshHosts, setSshHosts] = useState<
    { alias: string; host?: string | null; user?: string | null; port?: number | null; keyPath?: string | null }[]
  >([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void invoke<WslProbe>('pi_sync_probe_wsl')
      .then(setWslProbe)
      .catch((e) => {
        console.error('[data-sync] WSL 探测失败', e)
        setWslProbe({ available: false, distros: [], error: String(e) })
      })
    void invoke<DockerProbe>('pi_sync_probe_docker')
      .then(setDockerProbe)
      .catch((e) => {
        console.error('[data-sync] Docker 探测失败', e)
        setDockerProbe({ available: false, containers: [], error: String(e) })
      })
    void invoke<{ hosts: typeof sshHosts }>('pi_sync_ssh_config_hosts')
      .then((result) => setSshHosts(result.hosts ?? []))
      .catch((e) => {
        console.error('[data-sync] SSH config 读取失败', e)
      })
  }, [])

  const subtitle =
    kind === 'ssh'
      ? `${user || 'user'}@${host || 'host'}:${port || '22'}`
      : kind === 'wsl'
        ? distro || '默认发行版'
        : container || 'Docker 容器'

  const submit = async () => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const saved = await invoke<{ device: SyncDevice }>('pi_sync_device_save', {
        device: {
          id: '',
          kind,
          label: '',
          host: kind === 'ssh' ? host : undefined,
          port: kind === 'ssh' && port.trim() !== '' ? Number(port) : undefined,
          user: kind === 'ssh' ? user : undefined,
          auth: kind === 'ssh' ? authMethod : undefined,
          password: kind === 'ssh' && authMethod === 'password' ? password : undefined,
          keyPath: kind === 'ssh' && keyPath.trim() !== '' ? keyPath : undefined,
          privateKeyPassphrase:
            kind === 'ssh' && authMethod === 'privateKey' && passphrase !== '' ? passphrase : undefined,
          assetInstallMode: kind === 'ssh' ? assetInstallMode : undefined,
          distro: kind === 'wsl' ? distro : undefined,
          linuxUser: kind === 'wsl' ? linuxUser : undefined,
          container: kind === 'docker' ? container : undefined,
        },
      })
      const test = await invoke<{ ok: boolean; detail?: string; error?: string }>(
        'pi_sync_device_test',
        { id: saved.device.id },
      )
      if (!test.ok) {
        setError(`设备已保存，但连接测试失败：${test.error ?? '未知错误'}`)
        setNotice('可关闭本窗口，在设备行点「同步配置」重试。')
        return
      }
      onCreated()
    } catch (e) {
      console.error('[data-sync] 新建设备失败', e)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const tabs: { id: DeviceKind; label: string; icon: typeof ServerIcon }[] = [
    { id: 'ssh', label: 'SSH', icon: ServerIcon },
    { id: 'wsl', label: 'WSL', icon: TerminalIcon },
    { id: 'docker', label: 'Docker', icon: BoxIcon },
  ]

  const labelClass = 'mb-1.5 block text-sm text-muted-foreground'
  const inputClass =
    'h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-[var(--fl-accent)]'
  const hintClass = 'mt-1 text-xs text-muted-foreground'
  const segmentClass = 'inline-flex rounded-lg border border-border bg-muted/40 p-0.5'
  const segmentItem = (active: boolean) =>
    `rounded-md px-3 py-1 text-sm ${active ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground'}`

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
      <div className="set-acct-card" style={{ width: 760 }}>
        <div className="set-acct-card-body" style={{ gap: 14, padding: 24 }}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-foreground">新建连接</div>
              <div className="mt-1 font-mono text-sm text-muted-foreground">{subtitle}</div>
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

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className={segmentClass}>
              {tabs.map((tab) => {
                const Icon = tab.icon
                return (
                  <button
                    className={segmentItem(kind === tab.id)}
                    key={tab.id}
                    onClick={() => setKind(tab.id)}
                    type="button"
                  >
                    <Icon className="mr-1 inline size-3.5" /> {tab.label}
                  </button>
                )
              })}
            </div>
            {kind === 'ssh' && (
              <select
                aria-label="从 SSH config 选择"
                className="h-8 max-w-[16rem] rounded-md border border-border bg-background px-2 text-xs text-muted-foreground"
                disabled={sshHosts.length === 0}
                onChange={(e) => {
                  const selected = sshHosts.find((row) => row.alias === e.target.value)
                  if (!selected) return
                  setHost(selected.host ?? selected.alias)
                  if (selected.user) setUser(selected.user)
                  if (selected.port) setPort(String(selected.port))
                  if (selected.keyPath) setKeyPath(selected.keyPath)
                }}
                value=""
              >
                <option value="">
                  {sshHosts.length === 0 ? '未发现 SSH config Host' : '从 SSH config 选择…'}
                </option>
                {sshHosts.map((row) => (
                  <option key={row.alias} value={row.alias}>
                    {row.alias}
                  </option>
                ))}
              </select>
            )}
          </div>

          {kind === 'ssh' && (
            <div className="space-y-4">
              <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-3">
                <div>
                  <label className={labelClass} htmlFor="sync-ssh-host">主机</label>
                  <input
                    autoFocus
                    className={`${inputClass} font-mono`}
                    id="sync-ssh-host"
                    onChange={(e) => {
                      const text = e.target.value
                      // 粘贴 user@host:port 一次填好三个字段（ZCode parseSshPasteTarget）
                      const match = text.trim().match(/^(?:ssh\s+)?(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/)
                      if (match && text.includes('@')) {
                        setUser(match[1] ?? '')
                        setHost(match[2] ?? '')
                        setPort(match[3] ?? '22')
                        return
                      }
                      setHost(text)
                    }}
                    placeholder="输入主机地址或 IP，例如 192.168.1.100"
                    spellCheck={false}
                    value={host}
                  />
                </div>
                <div>
                  <label className={labelClass} htmlFor="sync-ssh-port">端口</label>
                  <input
                    className={`${inputClass} font-mono`}
                    id="sync-ssh-port"
                    inputMode="numeric"
                    onChange={(e) => setPort(e.target.value)}
                    placeholder="22"
                    value={port}
                  />
                </div>
              </div>

              <div>
                <label className={labelClass} htmlFor="sync-ssh-user">用户名</label>
                <input
                  className={`${inputClass} font-mono`}
                  id="sync-ssh-user"
                  onChange={(e) => setUser(e.target.value)}
                  placeholder="输入用户名，例如 root"
                  spellCheck={false}
                  value={user}
                />
              </div>

              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-sm text-muted-foreground">认证方式</span>
                  <div className={segmentClass}>
                    <button className={segmentItem(authMethod === 'password')} onClick={() => setAuthMethod('password')} type="button">
                      密码
                    </button>
                    <button className={segmentItem(authMethod === 'privateKey')} onClick={() => setAuthMethod('privateKey')} type="button">
                      私钥
                    </button>
                  </div>
                </div>
                {authMethod === 'password' ? (
                  <div className="relative">
                    <input
                      aria-label="SSH 密码"
                      autoComplete="off"
                      className={`${inputClass} pr-10`}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="输入 SSH 密码"
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                    />
                    <button
                      aria-label={showPassword ? '隐藏密码' : '显示密码'}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      onClick={() => setShowPassword((v) => !v)}
                      type="button"
                    >
                      <HelpCircle className="size-4" />
                    </button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div>
                      <input
                        aria-label="私钥路径"
                        className={`${inputClass} font-mono`}
                        onChange={(e) => setKeyPath(e.target.value)}
                        placeholder="私钥路径（留空使用 ssh agent / 默认密钥）"
                        spellCheck={false}
                        value={keyPath}
                      />
                    </div>
                    <div className="relative">
                      <input
                        aria-label="私钥口令"
                        autoComplete="off"
                        className={`${inputClass} pr-10`}
                        onChange={(e) => setPassphrase(e.target.value)}
                        placeholder="私钥口令（可选）"
                        type={showPassphrase ? 'text' : 'password'}
                        value={passphrase}
                      />
                      <button
                        aria-label={showPassphrase ? '隐藏口令' : '显示口令'}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        onClick={() => setShowPassphrase((v) => !v)}
                        type="button"
                      >
                        <HelpCircle className="size-4" />
                      </button>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <button
                  className="text-sm text-muted-foreground hover:text-foreground"
                  onClick={() => setAdvancedOpen((v) => !v)}
                  type="button"
                >
                  <span className="mr-1 inline-block" style={{ transform: advancedOpen ? 'rotate(90deg)' : undefined }}>▸</span>
                  高级选项
                </button>
                {advancedOpen && (
                  <div className="mt-3 space-y-2">
                    <span className={labelClass}>资源下载方式</span>
                    <div className={segmentClass}>
                      <button
                        className={segmentItem(assetInstallMode === 'local-download-upload')}
                        onClick={() => setAssetInstallMode('local-download-upload')}
                        type="button"
                      >
                        本地下载后上传
                      </button>
                      <button
                        className={segmentItem(false)}
                        disabled
                        title="宿主没有 ZCode CDN 与远端校验工具，仅支持本地下载后上传"
                        type="button"
                      >
                        远端服务器下载
                      </button>
                    </div>
                    <p className={hintClass}>
                      远端服务器下载需要服务器能访问 ZCode CDN 并具备下载、解压和校验工具；宿主未接入该 CDN，只能用本地下载后上传。
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {kind === 'wsl' && (
            <div className="space-y-4">
              <div>
                <label className={labelClass} htmlFor="sync-wsl-distro">发行版</label>
                <input
                  className={inputClass}
                  id="sync-wsl-distro"
                  list="sync-wsl-distros"
                  onChange={(e) => setDistro(e.target.value)}
                  placeholder="默认发行版"
                  value={distro}
                />
                <datalist id="sync-wsl-distros">
                  {(wslProbe?.distros ?? []).map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                <p className={hintClass}>
                  {wslProbe === null
                    ? '正在检测 WSL 发行版...'
                    : wslProbe.distros.length > 0
                      ? `当前设备检测到 ${wslProbe.distros.length} 个发行版。`
                      : '暂未检测到 WSL 发行版；如果本机已安装 WSL，仍可继续连接默认发行版。'}
                </p>
              </div>
              <div>
                <label className={labelClass} htmlFor="sync-wsl-user">Linux 用户</label>
                <input
                  className={inputClass}
                  id="sync-wsl-user"
                  onChange={(e) => setLinuxUser(e.target.value)}
                  placeholder="默认用户"
                  spellCheck={false}
                  value={linuxUser}
                />
                <p className={hintClass}>
                  留空使用发行版默认用户；填写 root 或其他已存在的 Linux 用户，将以该用户运行 WSL 命令。
                </p>
              </div>
            </div>
          )}

          {kind === 'docker' && (
            <div className="space-y-4">
              <div className={segmentClass}>
                <button className={segmentItem(dockerMode === 'select')} onClick={() => setDockerMode('select')} type="button">
                  选择运行中的容器
                </button>
                <button className={segmentItem(dockerMode === 'manual')} onClick={() => setDockerMode('manual')} type="button">
                  手动输入容器
                </button>
              </div>
              {dockerMode === 'select' ? (
                <div>
                  <label className={labelClass} htmlFor="sync-docker-select">容器</label>
                  <select
                    className={`${inputClass} px-2`}
                    id="sync-docker-select"
                    onChange={(e) => setContainer(e.target.value)}
                    value={container}
                  >
                    <option value="">
                      {dockerProbe === null
                        ? '正在检测运行中的容器...'
                        : dockerProbe.available
                          ? dockerProbe.containers.length > 0
                            ? '选择正在运行的容器'
                            : '没有运行中的容器'
                          : 'Docker 不可用'}
                    </option>
                    {(dockerProbe?.containers ?? []).map((row) => (
                      <option key={row.name} value={row.name}>{row.name}（{row.image}）</option>
                    ))}
                  </select>
                  <p className={hintClass}>
                    {dockerProbe?.available === false
                      ? `Docker 不可用：${dockerProbe.error ?? '请确认 Docker 正在运行'}`
                      : '如果运行中的容器列表不完整，可以切换「手动输入容器」。'}
                  </p>
                </div>
              ) : (
                <div>
                  <label className={labelClass} htmlFor="sync-docker-manual">容器</label>
                  <input
                    className={inputClass}
                    id="sync-docker-manual"
                    onChange={(e) => setContainer(e.target.value)}
                    placeholder="输入容器名或 ID，例如 my-container"
                    value={container}
                  />
                  <p className={hintClass}>如果运行中的容器列表不完整，可以手动输入容器名或 ID 连接。</p>
                </div>
              )}
            </div>
          )}

          {error !== null && <div className="set-err">{error}</div>}
          {notice !== null && <span className="set-saved">{notice}</span>}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <button className="set-btn" onClick={onClose} style={{ minWidth: 64 }} type="button">
              取消
            </button>
            <button
              className="set-btn set-btn-primary"
              disabled={busy}
              onClick={() => void submit()}
              style={{ background: '#111', color: '#fff', minWidth: 110 }}
              type="button"
            >
              {busy ? '连接中…' : '添加并连接'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function SyncDialog({
  device,
  categories,
  onClose,
  onSynced,
}: {
  device: SyncDevice
  categories: SyncCategory[]
  onClose: () => void
  onSynced: (transferred: string[], bytes: number) => void
}) {
  const supported = useMemo(() => categories.filter((c) => c.supported), [categories])
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(supported.filter((category) => category.count > 0).map((category) => category.key)),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const push = async () => {
    if (selected.size === 0) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const pushed = await invoke<{ transferred: string[]; bytes: number }>('pi_sync_push', {
        id: device.id,
        categories: [...selected],
      })
      setResult(
        `已推送：${pushed.transferred.join(' / ')}（${(pushed.bytes / 1024).toFixed(1)} KB）`,
      )
      onSynced(pushed.transferred, pushed.bytes)
    } catch (e) {
      console.error('[data-sync] 推送失败', e)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

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
      <div className="set-acct-card" style={{ width: 640 }}>
        <div className="set-acct-card-body" style={{ gap: 12, padding: 20 }}>
          <div className="set-actions" style={{ justifyContent: 'space-between' }}>
            <div>
              <div className="set-acct-field-label">数据同步 · {device.label}</div>
              <div className="set-hint" style={{ margin: '2px 0 0' }}>
                {kindLabel(device.kind)} · {device.endpoint} → ~/.rpi/agent
              </div>
            </div>
            <button className="set-btn" onClick={onClose} type="button">
              <X aria-hidden className="inline size-3.5" /> 关闭
            </button>
          </div>

          {categories.map((category) => (
            <div
              className="set-acct-field"
              key={category.key}
              style={{ alignItems: 'flex-start', borderTop: '1px solid var(--stroke-soft)', paddingTop: 8 }}
            >
              <div className="set-acct-field-text" style={{ flex: '1 1 0' }}>
                <span className="set-acct-field-label">{category.label}（{category.count}）</span>
                <p className="set-acct-field-desc" style={{ margin: 0 }}>
                  {category.supported
                    ? category.count === 0
                      ? '本机没有可同步的条目'
                      : (category.items ?? []).length > 6
                        ? `${(category.items ?? []).slice(0, 6).join('、')} 等 ${category.count} 项`
                        : (category.items ?? []).join('、')
                    : '宿主没有该分类的可推送配置'}
                </p>
              </div>
              <div className="set-acct-field-control">
                <input
                  checked={selected.has(category.key)}
                  disabled={!category.supported || category.count === 0 || busy}
                  onChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev)
                      if (next.has(category.key)) next.delete(category.key)
                      else next.add(category.key)
                      return next
                    })
                  }
                  type="checkbox"
                />
              </div>
            </div>
          ))}

          {error !== null && <div className="set-err">{error}</div>}
          {result !== null && <span className="set-saved">{result}</span>}

          <div className="set-actions" style={{ justifyContent: 'space-between' }}>
            <button
              className="set-btn"
              disabled={busy}
              onClick={() => void invoke('pi_sync_device_test', { id: device.id })}
              type="button"
            >
              测试连接
            </button>
            <button
              className="set-btn set-btn-primary"
              disabled={busy || selected.size === 0}
              onClick={() => void push()}
              type="button"
            >
              {busy ? '同步中…' : `推送选中（${selected.size}）`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
