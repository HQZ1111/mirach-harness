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

import { useCallback, useEffect, useState } from 'react'
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

/** 连接模式（hermes 同名联合类型原样保留——宿主只可能停在 'local'）。 */
export type GatewayMode = 'local' | 'remote' | 'cloud' | 'ssh'

/** `get_agui_endpoint` 返回形状（Rust 侧 agui::AguiState::endpoint）。 */
interface AguiEndpoint {
  port: number
  token: string
  version: string
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
const UNAVAILABLE_HINT = '宿主是本地单机形态——该模式需要网关后端，未实现'

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
    '应用默认会启动自己的本地网关（随应用启动，绑定 127.0.0.1 随机端口）。hermes 的远程网关 / Hermes Cloud / SSH 模式需要网关后端——宿主是本地单机形态，这些模式未实现（下方卡片置灰）。',
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
  // 连接模式：宿主固定 local。state 形状与 hermes 一致（其余三卡 disabled，
  // 永远无法选中；点 local 卡 = 选中已是当前的模式，与 hermes 同为无操作）。
  const [mode, setMode] = useState<GatewayMode>('local')

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

      {/* 连接模式四卡（hermes 原样：local 常亮可点、其余置灰 + hint） */}
      <div>
        <h4 className="set-sub-title">{G.modeTitle}</h4>
        <div className="mt-2 grid auto-rows-fr grid-cols-1 gap-2 sm:grid-cols-2">
          {GATEWAY_MODES.map((m) => (
            <ModeCard
              active={mode === m.id}
              description={m.description}
              disabled={m.disabled}
              hint={m.hint}
              icon={m.icon}
              key={m.id}
              onSelect={() => setMode(m.id)}
              title={m.title}
            />
          ))}
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
    </section>
  )
}
