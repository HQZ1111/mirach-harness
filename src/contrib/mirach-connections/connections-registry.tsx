/**
 * 连接注册表页——hermes `connections-registry.tsx` 的宿主移植：
 * KIND_ICONS / 列表行（icon + label + Current/Primary 徽章 + Test/Make
 * primary/Edit/Remove）/ 内联编辑器（kind 四选创建后固定 + label + url/host
 * 复合）/ launchMode 开关。
 *
 * 真假分界：local = 真面（test 走引擎在场检查）；remote/cloud = 真面
 * （test 用注册表 URL + keyring token 真连网关等 gateway.ready）；ssh =
 * 无隧道实现，test 返回 stub:true 红显（不装作连通）。
 */
import { useEffect, useMemo, useState, type FC } from 'react'
import { CloudIcon, MonitorIcon, GlobeIcon, TerminalIcon, PencilIcon, TrashIcon, PlusIcon, PlugZapIcon, CheckIcon, Loader2Icon } from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { cn } from '@/lib/utils'
import { useBotsStore } from '@/components/panes/hub/bots-store'
import { useStore } from 'zustand'
import { botsPanelStore, toggleBotsPanel } from '@/components/panes/hub/bots-panel-actions'

type ConnectionKind = 'cloud' | 'local' | 'remote' | 'ssh'

interface RegistryConnection {
  id: string
  kind: ConnectionKind
  label: string
  url?: string
  authMode?: string
  host?: string
  user?: string
  port?: number
  keyPath?: string
  remoteProfile?: string
  gatewayPort?: number
  tokenSet?: boolean
  tokenPreview?: null | string
}

interface ConnectionRegistry {
  version: number
  primary: string
  launchMode?: string
  lastUsed?: string
  connections: RegistryConnection[]
}

const KIND_ICONS: Record<ConnectionKind, typeof CloudIcon> = {
  cloud: CloudIcon,
  local: MonitorIcon,
  remote: GlobeIcon,
  ssh: TerminalIcon,
}
const KIND_LABELS: Record<ConnectionKind, string> = {
  cloud: '云',
  local: '本机',
  remote: '远端',
  ssh: 'SSH',
}

interface EditorState {
  id: null | string
  kind: ConnectionKind
  label: string
  url: string
  host: string
  user: string
  port: string
  remoteProfile: string
  gatewayPort: string
  /** 只写：非空 = 保存时写入 keyring（永不回显）。 */
  token: string
  /** 显式清除已存 token（保存时写空串）。 */
  clearToken: boolean
}

const emptyEditor = (): EditorState => ({
  id: null,
  kind: 'remote',
  label: '',
  url: '',
  host: '',
  user: '',
  port: '',
  remoteProfile: '',
  gatewayPort: '',
  token: '',
  clearToken: false,
})

/** ssh 复合键（hermes sshCompositeKey：user@host:port#profile）。 */
const sshKey = (e: Pick<EditorState, 'user' | 'host' | 'port' | 'remoteProfile'>) =>
  `${e.user.trim()}@${e.host.trim()}:${e.port.trim() || '22'}#${e.remoteProfile.trim()}`

function dupeError(e: EditorState, registry: ConnectionRegistry | null): null | string {
  const label = e.label.trim().toLowerCase()
  if (label && registry?.connections.some((c) => c.label.toLowerCase() === label && c.id !== e.id)) {
    return `名称「${e.label.trim()}」已被占用。`
  }
  if (e.kind === 'remote' || e.kind === 'cloud') {
    const url = e.url.trim().replace(/\/+$/, '').toLowerCase()
    if (url && registry?.connections.some((c) => c.id !== e.id && (c.url ?? '').trim().replace(/\/+$/, '').toLowerCase() === url)) {
      return '同 URL 的连接已存在。'
    }
  }
  if (e.kind === 'ssh') {
    const key = sshKey(e)
    if (
      e.host.trim() &&
      registry?.connections.some((c) => c.id !== e.id && c.kind === 'ssh' && sshKey({
        user: c.user ?? '',
        host: c.host ?? '',
        port: String(c.port ?? 22),
        remoteProfile: c.remoteProfile ?? '',
      }) === key)
    ) {
      return '同 ssh 目标的连接已存在。'
    }
  }
  return null
}

export const ConnectionsRegistrySection: FC = () => {
  const [registry, setRegistry] = useState<ConnectionRegistry | null>(null)
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<Record<string, { ok?: boolean; stub?: boolean; error?: string }>>({})
  const [removeTarget, setRemoveTarget] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [peer, setPeer] = useState<null | { url: string; port: number; token: string }>(null)
  const [copied, setCopied] = useState<null | string>(null)
  const refresh = useBotsStore((s) => s.load) // 机器人页监听同源刷新（松耦合：store 触碰）

  useEffect(() => {
    void invoke<ConnectionRegistry>('pi_connections_list')
      .then(setRegistry)
      .catch((e) => setError(String(e).slice(0, 200)))
    void invoke<{ url: string; port: number; token: string }>('pi_peer_info')
      .then(setPeer)
      .catch((e) => console.error('[connections] peer 服务信息读取失败', e))
  }, [])

  const copy = (label: string, value: string) => {
    void navigator.clipboard
      ?.writeText(value)
      .then(() => {
        setCopied(label)
        setTimeout(() => setCopied(null), 1500)
      })
      .catch((e) => console.error('[connections] 复制失败', e))
  }

  const openBots = useStore(botsPanelStore, (s) => s.open)

  const doTest = async (id: string) => {
    setTestingId(id)
    try {
      const result = await invoke<{ ok?: boolean; stub?: boolean; error?: string }>('pi_connections_test', { id })
      setTestResult((prev) => ({ ...prev, [id]: result }))
    } catch (e) {
      setTestResult((prev) => ({ ...prev, [id]: { ok: false, error: String(e).slice(0, 200) } }))
    } finally {
      setTestingId(null)
    }
  }

  const doRemove = async (id: string) => {
    setBusyId(id)
    try {
      setRegistry(await invoke<ConnectionRegistry>('pi_connections_remove', { id }))
      refresh()
    } catch (e) {
      setError(String(e).slice(0, 200))
    } finally {
      setBusyId(null)
      setRemoveTarget(null)
    }
  }

  const doSetPrimary = async (id: string) => {
    setBusyId(id)
    try {
      setRegistry(await invoke<ConnectionRegistry>('pi_connections_set_primary', { id }))
    } catch (e) {
      setError(String(e).slice(0, 200))
    } finally {
      setBusyId(null)
    }
  }

  const valid = useMemo(() => {
    if (!editor) return false
    if (!editor.label.trim()) return false
    if (editor.kind === 'remote' || editor.kind === 'cloud') return editor.url.trim().length > 0
    if (editor.kind === 'ssh') return editor.host.trim().length > 0
    return true
  }, [editor])

  const doSave = async () => {
    if (!editor || !valid) return
    try {
      const tokenField = editor.token.trim()
        ? { token: editor.token.trim() }
        : editor.clearToken
          ? { token: '' }
          : {}
      const connection = {
        id: editor.id ?? '',
        kind: editor.kind,
        label: editor.label.trim(),
        ...tokenField,
        ...(editor.kind === 'remote' || editor.kind === 'cloud'
          ? { url: editor.url.trim() }
          : {
              host: editor.host.trim(),
              user: editor.user.trim(),
              port: Number(editor.port) || 22,
              ...(editor.remoteProfile.trim() ? { remoteProfile: editor.remoteProfile.trim() } : {}),
              ...(editor.gatewayPort.trim() ? { gatewayPort: Number(editor.gatewayPort) } : {}),
            }),
      }
      setRegistry(await invoke<ConnectionRegistry>('pi_connections_save', { connection }))
      refresh()
      setEditor(null)
    } catch (e) {
      setError(String(e).slice(0, 200))
    }
  }

  const dupe = editor ? dupeError(editor, registry) : null
  const editingConn = editor?.id
    ? (registry?.connections.find((c) => c.id === editor.id) ?? null)
    : null

  return (
    <div className="flex flex-col gap-2" data-slot="connections-registry">
      <div className="flex items-center justify-between">
        <h3 className="text-foreground text-sm font-semibold">连接</h3>
        <button
          className="set-btn"
          onClick={() => setEditor(emptyEditor())}
          type="button"
        >
          <PlusIcon className="mr-1 inline size-[var(--size-icon-sm)]" />
          添加连接
        </button>
      </div>
      {error && <div className="set-err">{error}</div>}
      <div className="flex flex-col gap-1">
        {registry?.connections.map((conn) => {
          const Icon = KIND_ICONS[conn.kind]
          const isPrimary = registry.primary === conn.id
          const result = testResult[conn.id]
          return (
            <div
              className={cn(
                'border-border/70 flex items-center gap-2 rounded-lg border px-2.5 py-2',
                isPrimary && 'border-(--color-brand)/40',
              )}
              key={conn.id}
            >
              <Icon className="text-muted-foreground size-[var(--size-icon-md)] shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-foreground truncate text-[0.8125rem] font-medium">{conn.label}</span>
                  {isPrimary && (
                    <span className="bg-(--color-brand)/15 text-(--color-brand) rounded px-1 py-0.5 text-[0.625rem] font-semibold">
                      主要
                    </span>
                  )}
                  {conn.kind === 'local' && (
                    <span className="text-muted-foreground/70 rounded bg-muted px-1 py-0.5 text-[0.625rem]">
                      托管
                    </span>
                  )}
                  {(conn.kind === 'remote' || conn.kind === 'cloud') && (
                    <span
                      className={cn(
                        'rounded px-1 py-0.5 text-[0.625rem]',
                        conn.tokenSet
                          ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                          : 'text-muted-foreground/70 bg-muted',
                      )}
                      title={conn.tokenSet ? 'token 存在 OS 凭据管理器' : '该网关需要 token 时请编辑填写'}
                    >
                      {conn.tokenSet ? `token ${conn.tokenPreview ?? 'set'}` : '未配置 token'}
                    </span>
                  )}
                </div>
                <div className="text-muted-foreground truncate text-xs">
                  {conn.kind === 'local'
                    ? 'pi 本机引擎'
                    : conn.kind === 'ssh'
                      ? `${conn.user}@${conn.host}:${conn.port ?? 22}`
                      : (conn.url ?? KIND_LABELS[conn.kind])}
                </div>
                {result && (
                  <div
                    className={cn(
                      'mt-0.5 text-xs',
                      result.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400',
                    )}
                    data-stub={result.stub ? 'true' : undefined}
                  >
                    {result.ok
                      ? '✓ 已连通'
                      : result.stub
                        ? `✗ 未接通（占位面）—— ${result.error ?? ''}`
                        : `✗ ${result.error ?? '连接失败'}`}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                <button
                  aria-label={`测试 ${conn.label}`}
                  className="text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors"
                  disabled={testingId === conn.id}
                  onClick={() => void doTest(conn.id)}
                  title="测试连接"
                  type="button"
                >
                  {testingId === conn.id ? (
                    <Loader2Icon className="size-[var(--size-icon-sm)] animate-spin" />
                  ) : (
                    <PlugZapIcon className="size-[var(--size-icon-sm)]" />
                  )}
                </button>
                {!isPrimary && (
                  <button
                    aria-label={`设为主要 ${conn.label}`}
                    className="text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors"
                    disabled={busyId === conn.id}
                    onClick={() => void doSetPrimary(conn.id)}
                    title="设为主要"
                    type="button"
                  >
                    <CheckIcon className="size-[var(--size-icon-sm)]" />
                  </button>
                )}
                {conn.kind !== 'local' && (
                  <>
                    <button
                      aria-label={`编辑 ${conn.label}`}
                      className="text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors"
                      onClick={() =>
                        setEditor({
                          id: conn.id,
                          kind: conn.kind,
                          label: conn.label,
                          url: conn.url ?? '',
                          host: conn.host ?? '',
                          user: conn.user ?? '',
                          port: String(conn.port ?? 22),
                          remoteProfile: conn.remoteProfile ?? '',
                          gatewayPort: conn.gatewayPort ? String(conn.gatewayPort) : '',
                          token: '',
                          clearToken: false,
                        })
                      }
                      title="编辑"
                      type="button"
                    >
                      <PencilIcon className="size-[var(--size-icon-sm)]" />
                    </button>
                    <button
                      aria-label={`删除 ${conn.label}`}
                      className={cn(
                        'rounded-md p-1.5 transition-colors',
                        removeTarget === conn.id
                          ? 'text-rose-600 dark:text-rose-400'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                      onClick={() => {
                        if (removeTarget === conn.id) void doRemove(conn.id)
                        else setRemoveTarget(conn.id)
                      }}
                      title={removeTarget === conn.id ? '再次点击确认删除' : '删除'}
                      type="button"
                    >
                      <TrashIcon className="size-[var(--size-icon-sm)]" />
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* 内联编辑器（hermes connections-registry:695-873） */}
      {editor && (
        <div className="border-border/70 rounded-xl border p-3">
          <div className="mb-2 flex flex-wrap gap-1">
            {(['local', 'cloud', 'remote', 'ssh'] as ConnectionKind[]).map((kind) => {
              const Icon = KIND_ICONS[kind]
              const disabled =
                kind === 'local' && Boolean(registry?.connections.some((c) => c.kind === 'local' && c.id !== editor.id))
              return (
                <button
                  className={cn(
                    'flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-colors',
                    editor.kind === kind ? 'border-(--color-brand) text-(--color-brand)' : 'border-border text-muted-foreground hover:text-foreground',
                    disabled && 'cursor-not-allowed opacity-40',
                  )}
                  disabled={disabled}
                  key={kind}
                  onClick={() => setEditor({ ...editor, kind })}
                  type="button"
                >
                  <Icon className="size-[var(--size-icon-sm)]" />
                  {KIND_LABELS[kind]}
                </button>
              )
            })}
          </div>
          <div className="set-field">
            <label className="set-field-label" htmlFor="conn-label">名称</label>
            <div className="set-field-control">
              <input
                autoFocus
                className="set-input"
                id="conn-label"
                onChange={(e) => setEditor({ ...editor, label: e.target.value })}
                placeholder="Homelab / Work laptop"
                value={editor.label}
              />
            </div>
          </div>
          {(editor.kind === 'remote' || editor.kind === 'cloud') && (
            <>
              <div className="set-field">
                <label className="set-field-label" htmlFor="conn-url">Gateway URL</label>
                <div className="set-field-control">
                  <input
                    className="set-input"
                    id="conn-url"
                    onChange={(e) => setEditor({ ...editor, url: e.target.value })}
                    placeholder="https://gw.example.com"
                    value={editor.url}
                  />
                </div>
              </div>
              <div className="set-field">
                <label className="set-field-label" htmlFor="conn-token">Gateway token</label>
                <div className="set-field-control">
                  <input
                    className="set-input"
                    id="conn-token"
                    onChange={(e) => setEditor({ ...editor, token: e.target.value, clearToken: false })}
                    placeholder={
                      editingConn?.tokenSet
                        ? `已配置（${editingConn.tokenPreview ?? 'set'}）——留空保持不变`
                        : '可选；写入 OS 凭据管理器'
                    }
                    type="password"
                    value={editor.token}
                  />
                </div>
                {editingConn?.tokenSet && !editor.clearToken && (
                  <button
                    className="set-btn mt-1 w-fit"
                    onClick={() => setEditor({ ...editor, token: '', clearToken: true })}
                    type="button"
                  >
                    清除已存 token
                  </button>
                )}
                {editor.clearToken && (
                  <div className="text-muted-foreground mt-1 text-xs">保存后将清除该连接的 token。</div>
                )}
              </div>
            </>
          )}
          {editor.kind === 'ssh' && (
            <>
              <div className="set-field">
                <label className="set-field-label" htmlFor="conn-host">主机（user@host:port）</label>
                <div className="set-field-control">
                  <input
                    className="set-input"
                    id="conn-host"
                    onChange={(e) => setEditor({ ...editor, host: e.target.value })}
                    placeholder="user@192.168.1.10:22"
                    value={editor.host}
                  />
                </div>
              </div>
              <div className="set-field">
                <label className="set-field-label" htmlFor="conn-user">用户（复合进主机可留空）</label>
                <div className="set-field-control">
                  <input
                    className="set-input"
                    id="conn-user"
                    onChange={(e) => setEditor({ ...editor, user: e.target.value })}
                    value={editor.user}
                  />
                </div>
              </div>
              <div className="set-field">
                <label className="set-field-label" htmlFor="conn-port">端口</label>
                <div className="set-field-control">
                  <input
                    className="set-input"
                    id="conn-port"
                    onChange={(e) => setEditor({ ...editor, port: e.target.value })}
                    placeholder="22"
                    value={editor.port}
                  />
                </div>
              </div>
              <div className="set-field">
                <label className="set-field-label" htmlFor="conn-profile">远端 profile（可选）</label>
                <div className="set-field-control">
                  <input
                    className="set-input"
                    id="conn-profile"
                    onChange={(e) => setEditor({ ...editor, remoteProfile: e.target.value })}
                    value={editor.remoteProfile}
                  />
                </div>
              </div>
              <div className="set-field">
                <label className="set-field-label" htmlFor="conn-gw-port">网关端口</label>
                <div className="set-field-control">
                  <input
                    className="set-input"
                    id="conn-gw-port"
                    onChange={(e) => setEditor({ ...editor, gatewayPort: e.target.value })}
                    placeholder="8642（hermes 默认）"
                    value={editor.gatewayPort}
                  />
                </div>
              </div>
            </>
          )}
          {dupe && <div className="set-err">{dupe}</div>}
          {editor.kind === 'ssh' && (
            <div className="text-muted-foreground mt-1 text-xs">
              保存后「测试」会起 `ssh -N -L` 隧道到远端网关并等 gateway.ready；需要密钥已在 agent 里。
            </div>
          )}
          <div className="set-actions">
            <button className="set-btn pressable" onClick={() => setEditor(null)} type="button">
              取消
            </button>
            <button
              className="set-btn set-btn-primary pressable"
              disabled={!valid || Boolean(dupe)}
              onClick={() => void doSave()}
              type="button"
            >
              {editor.id ? '保存' : '添加'}
            </button>
          </div>
        </div>
      )}

      {/* 本机 Peer 服务（跨网关借出面，2026-11-18）：对端 mirach 用
          URL + 令牌接入后，可把本机 bot 拉进它的 canonical 房间。 */}
      {peer && (
        <div className="border-border/70 rounded-xl border px-3 py-2" data-slot="peer-service">
          <div className="flex items-center justify-between">
            <h3 className="text-foreground text-sm font-semibold">本机 Peer 服务</h3>
            <span className="text-muted-foreground/70 text-[0.625rem]">跨网关借出</span>
          </div>
          <div className="text-muted-foreground mt-1 text-xs">
            对端把 URL 和令牌填进它自己的连接配置后，就能把本机机器人拉进房间。
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="text-muted-foreground text-xs">URL</span>
            <code className="bg-muted/60 min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-[0.6875rem]">
              {peer.url}
            </code>
            <button
              className="set-btn shrink-0"
              onClick={() => copy('url', peer.url)}
              type="button"
            >
              {copied === 'url' ? '已复制' : '复制'}
            </button>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-muted-foreground text-xs">令牌</span>
            <code className="bg-muted/60 min-w-0 flex-1 truncate rounded px-1.5 py-0.5 text-[0.6875rem]">
              {'•'.repeat(12)}…{peer.token.slice(-6)}
            </code>
            <button
              className="set-btn shrink-0"
              onClick={() => copy('token', peer.token)}
              type="button"
            >
              {copied === 'token' ? '已复制' : '复制'}
            </button>
          </div>
          <div className="text-muted-foreground/60 mt-1 text-[0.625rem]">
            令牌等同本机网关访问权，只交给受信任的对端。
          </div>
        </div>
      )}

      <div className="text-muted-foreground/80 text-xs">
        「{openBots ? '收起' : '打开'}机器人」弹出栏后，花名册按连接分组。远端连接配好 URL 与 token
        后点「测试」会真连网关（等 gateway.ready）；SSH 连接会先起 `ssh -N -L` 隧道再探。
        <button className="ml-1 underline" onClick={toggleBotsPanel} type="button">
          {openBots ? '收起机器人栏' : '打开机器人栏'}
        </button>
      </div>
    </div>
  )
}
