/**
 * 网关连接 —— hermes `apps/desktop/src/app/settings/gateway-settings.tsx`
 * 的**本地单机形态**移植（2026-10-24）。
 *
 * 范围裁剪（宿主 = mirach 本地单机：引擎 pi 随应用启动，AG-UI 绑定
 * 127.0.0.1:0 + 自动生成 token，经 IPC `get_agui_endpoint` 下发；没有
 * 连接注册表 / Hermes Cloud 门户 / safeStorage 钥匙串）：
 *   · 连接模式四卡照 hermes 原样渲染（local 常亮可点，云/远程/SSH 置灰，
 *     hint 用原生 title 注明未实现——不伪造可切换的模式）；
 *   · 本地面板：hermes 的 local 模式本无表单字段（网关就在本机跑），等价物
 *     是端点状态块——监听地址 / 协议版本 / token（显示/隐藏 + 端点与 token
 *     各自独立复制）；
 *   · 诊断行：hermes 的 revealLogs（打开 desktop.log）无宿主对应——日志随
 *     stdout 输出，按钮改为复制应用数据目录路径，title 说明真相（不假装
 *     能打开日志文件）。
 *
 *   不移植：getConnectionConfig / saveConnectionConfig /
 *   applyConnectionConfig / testConnectionConfig / cloud.* / ssh* /
 *   getSecretStorageEncryption——宿主没有这些 IPC，也绝不伪造调用（铁律
 *   11/12：不兜底、不假装成功）。远程 URL / SSH 表单、连接注册表、云端
 *   代理选择器、钥匙串加密开关都是网关后端特性，整体不存在。
 *
 * 文案：hermes i18n `settings.gateway` 段简体中文（apps/desktop/src/i18n/
 * zh.ts 1382-1511；zh-hant_settings.ts 是同段繁体版且缺 cloud 键——上游
 * zh-hant 落后于 zh，宿主 UI 语言为简体，故以 zh 为源）。指向未移植特性
 * 的句子换成如实的未实现说明，逐字段注释标明出处与改动。
 *
 * 样式：set-* 体系（overlays.css）+ 少量 Tailwind 排版类（模式卡没有
 * set 原语，用宿主 CSS 令牌的任意值类拼装；无 shadcn 导入）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { appDataDir } from '@tauri-apps/api/path'
import {
  Check,
  Cloud,
  Globe,
  HelpCircle,
  Monitor,
  Terminal,
} from 'lucide-react'

import { inTauri } from '@/lib/tauri-window'
import { ConnectionsRegistrySection } from '@/contrib/mirach-connections/connections-registry'

/** 连接模式（hermes 同名联合类型原样保留——宿主只可能停在 'local'）。 */
export type GatewayMode = 'local' | 'remote' | 'cloud' | 'ssh'

/** `get_agui_endpoint` 返回形状（Rust 侧 agui::AguiState::endpoint）。 */
interface AguiEndpoint {
  port: number
  token: string
  version: string
}

/** 连接注册表行（`pi_connections_list` 的投影；token 永不在 wire 里）。 */
interface RegistryConnectionRow {
  id: string
  kind: GatewayMode
  label: string
}

/** 模式卡定义（GATEWAY_MODES 的条目）。 */
export interface GatewayModeDef {
  id: GatewayMode
  title: string
  description: string
  icon: typeof Monitor
  /** true = 该模式需要网关后端，宿主未实现（卡片置灰，hint 说明原因）。 */
  disabled: boolean
  /** 置灰原因，渲染成 HelpCircle 的原生 title（hermes 用 Tip 浮层）。 */
  hint?: string
}

/** 置灰卡的统一原因（宿主本地单机、无网关后端——如实说明，不假装可切换）。 */
const UNAVAILABLE_HINT = '暂无该类型连接——在下方「连接注册表」里添加远程网关 / 云 / SSH 设备（本窗口仍使用本机引擎）'

/**
 * 四张模式卡（顺序同 hermes：local / cloud / remote / ssh）。
 * 文案出处 hermes zh.ts settings.gateway：localDesc 1394、cloudDesc 1399、
 * remoteDesc 1396、sshDesc 1489-1490。两处措辞调整：
 *   · localDesc 的「Hermes 后端」→「pi 引擎后端」——本地模式在宿主真实
 *     存在，描述必须指向真实引擎（pi）；
 *   · 云/远程/SSH 三卡描述的是 hermes 特性本身，保留原文；能不能用交给
 *     disabled + hint 说明，不在描述里说谎。
 */
export const GATEWAY_MODES: readonly GatewayModeDef[] = [
  {
    description: '在 localhost 启动私有 pi 引擎后端。这是默认方式，并且可离线工作。',
    disabled: false,
    icon: Monitor,
    id: 'local',
    title: '本地网关',
  },
  {
    description: '只需登录 Hermes Cloud 一次，即可从你账户下的智能体中选择——无需粘贴 URL。',
    disabled: true,
    hint: UNAVAILABLE_HINT,
    icon: Cloud,
    id: 'cloud',
    title: 'Hermes Cloud',
  },
  {
    description: '将此桌面外壳连接到远程 Hermes 后端。',
    disabled: true,
    hint: UNAVAILABLE_HINT,
    icon: Globe,
    id: 'remote',
    title: '远程网关',
  },
  {
    description:
      'Hermes 会通过 SSH 在远程启动并以隧道连接到本应用——无需自行启动或暴露任何服务。前提：已具备到该主机的密钥 SSH 访问。',
    disabled: true,
    hint: UNAVAILABLE_HINT,
    icon: Terminal,
    id: 'ssh',
    title: '通过 SSH 连接',
  },
]

/**
 * 界面文案（zh 硬编码）。出处 hermes zh.ts settings.gateway：title 1386、
 * modeTitle 1392、diagnostics 1465、openLogs 1467。改动逐条注明：
 *   · intro——hermes 原文第二句「可以使用远程网关」描述未移植特性 → 按铁律
 *     12 换成未实现说明；第三句（profile 从网关发现）是网关后端特性，略去；
 *   · diagnosticsDesc——hermes 原文「在文件管理器中显示 desktop.log…」
 *     描述 revealLogs（未移植）→ 如实替换；
 *   · 端点块各串沿用 settings-overlay.tsx 核心连接节的既有用词（宿主词汇）。
 */
const G = {
  accessToken: '访问 token',
  copyEndpoint: '复制端点',
  copyEndpointDone: '端点已复制到剪贴板',
  copyToken: '复制 token',
  copyTokenDone: 'token 已复制到剪贴板',
  diagnostics: '诊断',
  diagnosticsDesc: '日志随 stdout 输出，开发模式在终端查看。',
  diagnosticsHelp:
    '日志随 stdout 输出，开发模式在终端查看；点击复制应用数据目录路径',
  endpointHint:
    '引擎在启动时绑定 127.0.0.1:0（随机端口）并生成访问 token；事件流与会话控制都走这个本地端点。它不对外网开放，也没有可改的配置——这里只读展示。',
  endpointTitle: 'AG-UI 端点',
  hideToken: '隐藏 token',
  intro:
    '应用默认会启动自己的本地网关（随应用启动，绑定 127.0.0.1 随机端口），当前窗口固定使用它。远程网关 / Hermes Cloud / SSH 由本页下方「连接注册表」承载（网关 WS RPC + ssh -N -L 隧道），供机器人跨网关与数据同步使用；这里显示它们的配置状态。',
  listenAddr: '监听地址',
  loading: '加载中…',
  logsCopied: (dir: string) => `已复制应用数据目录路径：${dir}`,
  modeTitle: '连接模式',
  openLogs: '打开日志',
  protoVersion: '协议版本',
  showToken: '显示 token',
  statusLabel: '连接状态',
  title: '网关连接',
} as const

/**
 * IPC 失败 → 用户能看懂的一句话（与 settings-overlay.tsx 的同名函数同语义；
 * 独立成局部函数，避免组件文件反向依赖浮层文件）。浏览器直开
 * （inTauri === false）时每个 invoke 都抛
 * `TypeError: Cannot read properties of undefined (reading 'invoke')`——
 * 翻译成「没有桌面宿主后端」。只翻译不吞错：原始错误已由各调用点的
 * console.error 打出（铁律 12）。
 */
function describeIpcError(e: unknown): string {
  if (!inTauri) {
    return '浏览器直开模式：没有桌面宿主后端，设置项不可读写（打包后的桌面应用里可用）'
  }
  return e instanceof Error ? e.message : String(e)
}

/**
 * 模式卡（hermes ModeCard 的宿主样式版）。hint 用原生 title（hermes 用
 * Tip 浮层；宿主设置页没有该原语，native title 同样悬停可读）。
 * 置灰卡沿用 hermes 的 disabled:opacity-50 / cursor-not-allowed。
 */
function ModeCard({
  active,
  description,
  disabled,
  hint,
  icon: Icon,
  onSelect,
  title,
}: {
  active: boolean
  description: string
  disabled?: boolean
  hint?: string
  icon: typeof Monitor
  onSelect: () => void
  title: string
}) {
  return (
    <button
      className={[
        'flex h-full w-full flex-col rounded-[var(--radius-control)] border p-3 text-left transition-colors',
        disabled
          ? 'cursor-not-allowed border-[var(--stroke-soft)] opacity-50'
          : active
            ? 'border-[var(--fl-accent)] bg-[var(--hover-wash)]'
            : 'border-[var(--stroke)] hover:border-[var(--fl-accent)]',
      ].join(' ')}
      disabled={disabled}
      onClick={onSelect}
      type="button"
    >
      <span className="flex w-full items-center gap-1.5">
        <Icon aria-hidden className="size-3.5 shrink-0 text-[var(--text-3)]" />
        <span
          className="min-w-0 font-medium text-[var(--text)]"
          style={{ fontSize: 'var(--font-sm)' }}
        >
          {title}
        </span>
        {hint !== undefined && (
          <span
            className="cursor-help text-[var(--text-4)]"
            onClick={(e) => e.stopPropagation()}
            title={hint}
          >
            <HelpCircle aria-hidden className="size-3.5" />
          </span>
        )}
        {active && (
          <Check aria-hidden className="ml-auto size-3.5 shrink-0 text-[var(--fl-accent)]" />
        )}
      </span>
      <span
        className="mt-1.5 text-[var(--text-3)]"
        style={{ fontSize: 'var(--font-caption)', lineHeight: 1.6 }}
      >
        {description}
      </span>
    </button>
  )
}

/**
 * 网关连接设置（本地单机形态）。宿主导航只有「核心连接」一项，无子页。
 */
export function GatewaySettings() {
  // 连接模式：主窗口引擎固定 local（远程连接是注册表条目，供跨网关/数据同步用）。
  const [mode, setMode] = useState<GatewayMode>('local')
  // 连接注册表嵌在本页底部（hermes gateway-settings 同样内嵌 ConnectionsRegistrySection）。
  const registryRef = useRef<HTMLDivElement | null>(null)
  const scrollToRegistry = () => {
    registryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  // 模式卡 → 连接注册表的添加表单（hermes 的"选模式即进入配置"）。
  const [addKind, setAddKind] = useState<GatewayMode>('remote')
  const [openEditorSignal, setOpenEditorSignal] = useState(0)
  const openAdd = (kind: GatewayMode) => {
    setAddKind(kind)
    setOpenEditorSignal((n) => n + 1)
    scrollToRegistry()
  }

  // 连接注册表（远程/云/SSH 真状态；null = 加载中）。
  const [connections, setConnections] = useState<RegistryConnectionRow[] | null>(null)
  const [connectionsError, setConnectionsError] = useState<string | null>(null)

  // AG-UI 端点（null = 载入中，可见状态；错误红条 + console.error，不静默）
  const [endpoint, setEndpoint] = useState<AguiEndpoint | null>(null)
  const [endpointError, setEndpointError] = useState<string | null>(null)
  const [tokenShown, setTokenShown] = useState(false)

  // 复制反馈：端点/token 一组、诊断一组（各自渲染在各自的块内，
  // 互不串位）。失败 console.error + 红条（铁律 12）。
  const [endpointCopied, setEndpointCopied] = useState<string | null>(null)
  const [endpointCopyError, setEndpointCopyError] = useState<string | null>(null)
  const [logsCopied, setLogsCopied] = useState<string | null>(null)
  const [logsCopyError, setLogsCopyError] = useState<string | null>(null)

  // 端点发现（宿主绑定 127.0.0.1:0 后经 IPC 下发；主动拉取避免启动竞态）。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const ep = await invoke<AguiEndpoint>('get_agui_endpoint')
        if (!cancelled) {
          setEndpoint(ep)
          setEndpointError(null)
        }
      } catch (e) {
        console.error('[gateway] AG-UI 端点获取失败', e)
        if (!cancelled) setEndpointError(describeIpcError(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // 连接注册表（远程/云/SSH 的真实配置；失败红显，不按"没有"处理）。
  useEffect(() => {
    let cancelled = false
    void invoke<{ connections?: RegistryConnectionRow[] }>('pi_connections_list')
      .then((registry) => {
        if (!cancelled) {
          setConnections(registry.connections ?? [])
          setConnectionsError(null)
        }
      })
      .catch((e: unknown) => {
        console.error('[gateway] 连接注册表读取失败', e)
        if (!cancelled) setConnectionsError(describeIpcError(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  // async 包一层：clipboard 不可用（非安全上下文）时 writeText 的同步
  // throw 也变成 rejection，统一走调用方的 .catch（不会炸出点击处理器）。
  const copyText = useCallback(async (text: string): Promise<void> => {
    await navigator.clipboard.writeText(text)
  }, [])

  const onCopyEndpoint = useCallback(() => {
    if (endpoint === null) return
    void copyText(`http://127.0.0.1:${endpoint.port}`)
      .then(() => {
        setEndpointCopied(G.copyEndpointDone)
        setEndpointCopyError(null)
      })
      .catch((e: unknown) => {
        console.error('[gateway] 端点复制失败', e)
        setEndpointCopied(null)
        setEndpointCopyError(describeIpcError(e))
      })
  }, [copyText, endpoint])

  const onCopyToken = useCallback(() => {
    if (endpoint === null) return
    void copyText(endpoint.token)
      .then(() => {
        setEndpointCopied(G.copyTokenDone)
        setEndpointCopyError(null)
      })
      .catch((e: unknown) => {
        console.error('[gateway] token 复制失败', e)
        setEndpointCopied(null)
        setEndpointCopyError(describeIpcError(e))
      })
  }, [copyText, endpoint])

  // 诊断行（hermes revealLogs 的诚实替身）：宿主日志随 stdout 输出，没有
  // desktop.log 可 reveal。按钮复制应用数据目录路径（配置文档所在侧的
  // 诊断入口），按钮 title 说明真相。取目录与写剪贴板任一步失败都可见。
  const onOpenLogs = useCallback(() => {
    void appDataDir()
      .then((dir) =>
        copyText(dir).then(() => {
          setLogsCopied(G.logsCopied(dir))
          setLogsCopyError(null)
        }),
      )
      .catch((e: unknown) => {
        console.error('[gateway] 诊断路径复制失败', e)
        setLogsCopied(null)
        setLogsCopyError(describeIpcError(e))
      })
  }, [copyText])

  return (
    <section className="set-section">
      {/* 页题 + 引言（hermes g.title / g.intro；引言见 G.intro 注释的取舍） */}
      <div>
        <h4 className="set-sub-title">{G.title}</h4>
        <p className="set-hint">{G.intro}</p>
      </div>

      {/* 连接模式四卡：本机 = 当前窗口引擎；远程/云/SSH = 连接注册表里的真实条目
          （有则显示数量与名称并跳「连接」页，无则置灰并指向同一入口）。 */}
      <div>
        <h4 className="set-sub-title">{G.modeTitle}</h4>
        <div className="mt-2 grid auto-rows-fr grid-cols-1 gap-2 sm:grid-cols-2">
          {GATEWAY_MODES.map((m) => {
            if (m.id === 'local') {
              return (
                <ModeCard
                  active
                  description="本机引擎随应用启动（127.0.0.1 随机端口）——当前窗口固定使用本机网关。"
                  icon={m.icon}
                  key={m.id}
                  onSelect={() => setMode('local')}
                  title={m.title}
                />
              )
            }
            const rows = (connections ?? []).filter((row) => row.kind === m.id)
            const configured = rows.length > 0
            return (
              <ModeCard
                active={false}
                description={
                  configured
                    ? `已配置 ${rows.length} 个：${rows.map((row) => row.label).join('、')}`
                    : m.description
                }
                // 未配置也允许点击：直接打开该 kind 的添加表单（hermes 的
                // 选模式 → 填表语义）；只有登记表还在加载时禁用。
                disabled={connections === null}
                hint={
                  configured
                    ? '在下方「连接注册表」管理该连接；数据同步页可把 MCP 配置推送到这些设备'
                    : '点击后跳到下方「连接注册表」并打开添加表单'
                }
                icon={m.icon}
                key={m.id}
                onSelect={() =>
                  configured ? scrollToRegistry() : openAdd(m.id)
                }
                title={m.title}
              />
            )
          })}
        </div>
        {connectionsError !== null && <div className="set-err">{connectionsError}</div>}
        <p className="set-hint" style={{ marginTop: 8 }}>
          本宿主的主窗口始终使用本机引擎；远程网关 / 云 / SSH 连接供跨网关机器人、
          花名册分组与数据同步使用。hermes 的「保存并重连」（把桌面外壳切到远端
          backend）未移植——它需要整套远端 backend 模式，宿主没有这条链路。
          凭据一律写入 OS 凭据管理器，没有明文 token 模式。
        </p>
        <div className="set-actions" style={{ justifyContent: 'space-between', marginTop: 8 }}>
          <span className="set-row-source">
            {connections === null
              ? '正在读取连接注册表…'
              : `连接注册表：远程 ${connections.filter((row) => row.kind === 'remote').length} · 云 ${
                  connections.filter((row) => row.kind === 'cloud').length
                } · SSH ${connections.filter((row) => row.kind === 'ssh').length}`}
          </span>
          <button className="set-btn" onClick={scrollToRegistry} style={{ whiteSpace: 'nowrap' }} type="button">
            管理连接
          </button>
        </div>
      </div>

      {/* 本地面板（hermes local 模式无表单字段；宿主等价物 = 端点状态块） */}
      <div>
        <h4 className="set-sub-title">{G.endpointTitle}</h4>
        <p className="set-hint">{G.endpointHint}</p>
        {endpointError !== null && <div className="set-err">{endpointError}</div>}
        {endpoint === null && endpointError === null && (
          <span className="set-file-missing">{G.loading}</span>
        )}
        {endpoint !== null && (
          <>
            <div className="set-row">
              <span className="set-row-provider">{G.statusLabel}</span>
              <span className="set-row-ok">已连接 ✓</span>
              <span className="set-row-source">
                引擎随应用启动并在本机监听（端点由宿主进程下发）
              </span>
            </div>
            <dl className="set-about-defs">
              <dt>{G.listenAddr}</dt>
              <dd className="set-code">{`127.0.0.1:${endpoint.port}`}</dd>
              <dt>{G.protoVersion}</dt>
              <dd className="set-code">{endpoint.version}</dd>
              <dt>{G.accessToken}</dt>
              <dd className="set-row-env">
                {tokenShown ? endpoint.token : `${endpoint.token.slice(0, 6)}••••••••`}
              </dd>
            </dl>
            <div className="set-actions">
              <button
                className="set-btn"
                onClick={() => setTokenShown((v) => !v)}
                type="button"
              >
                {tokenShown ? G.hideToken : G.showToken}
              </button>
              <button className="set-btn" onClick={onCopyEndpoint} type="button">
                {G.copyEndpoint}
              </button>
              <button className="set-btn" onClick={onCopyToken} type="button">
                {G.copyToken}
              </button>
              {endpointCopied !== null && <span className="set-saved">{endpointCopied}</span>}
            </div>
            {endpointCopyError !== null && (
              <div className="set-err">{endpointCopyError}</div>
            )}
          </>
        )}
      </div>

      {/* 诊断行（hermes ListRow：诊断 + 打开日志） */}
      <div className="set-row">
        <span className="set-row-provider">{G.diagnostics}</span>
        <span className="set-row-source">{G.diagnosticsDesc}</span>
        <span className="set-actions">
          <button
            className="set-btn"
            onClick={onOpenLogs}
            title={G.diagnosticsHelp}
            type="button"
          >
            {G.openLogs}
          </button>
        </span>
      </div>
      {logsCopied !== null && <span className="set-saved">{logsCopied}</span>}
      {logsCopyError !== null && <div className="set-err">{logsCopyError}</div>}

      {/* 连接注册表（hermes gateway-settings 同样内嵌 ConnectionsRegistrySection）：
          远程网关 / 云 / SSH 的增删改、凭据写入 OS 凭据管理器、测试连接与设为主要。 */}
      <div ref={registryRef}>
        <h4 className="set-sub-title">连接注册表</h4>
        <p className="set-hint">
          远程网关 / Hermes Cloud / SSH 设备都在这里增删改；「测试」对 remote/cloud
          真连网关等 `gateway.ready`，SSH 先起 `ssh -N -L` 隧道再探活。凭据写入
          OS 凭据管理器，界面只显示派生态。
        </p>
        <ConnectionsRegistrySection
          initialKind={addKind}
          openEditorSignal={openEditorSignal}
        />
      </div>
    </section>
  )
}
