/**
 * 设置页宿主（openhuman settings 壳 + mirach 数据面）。
 *
 * 结构照抄 openhuman：左导航（`sidebarGroups()` 分组的 registry 条目）+
 * 右面板（registry 的 id → 面板组件）。差异：
 * - **不做多语言**（用户决定）：i18n 影子层固定英文；
 * - 无 react-router：导航走 `settingsNavStore`；
 * - 数据接 pi 的 IPC；**引擎侧没有的面板显示「引擎侧缺数据」占位**
 *   （不删 UI，由用户决定后续删或补引擎）。
 */
import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

import SettingsLayout from './layout/SettingsLayout'
import SettingsPanel from './layout/SettingsPanel'
import { useSettingsNavigation } from './hooks/useSettingsNavigation'
import { findEntryById } from './settingsRouteRegistry'
import { useT } from './i18n'
import { Card } from './ui-kit/index'

/** 通用提示条（openhuman 的 StatusLine 是"保存状态"专用，不适用这里）。 */
const Notice = ({ kind, children }: { kind: 'warning' | 'neutral'; children: React.ReactNode }) => (
  <div
    data-slot="settings-notice"
    className={
      kind === 'warning'
        ? 'rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300'
        : 'rounded-lg bg-foreground/[0.05] px-3 py-2 text-sm text-foreground/60'
    }
  >
    {children}
  </div>
)

// ── 引擎侧缺数据的统一占位 ─────────────────────────────────────────────
const EngineGapPanel = ({ title, why }: { title: string; why: string }) => (
  <SettingsPanel title={title} description="This section has no engine backing yet.">
    <Card>
      <Notice kind="warning">引擎侧缺数据：{why}</Notice>
      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
        这个面板的 UI 已从 openhuman 移植，但 pi 内核没有对应的数据源。
        可以做两件事：①删除该面板；②在 src-tauri 侧补对应能力。
        详见 <code>docs/openhuman-migration-plan.md</code>。
      </p>
    </Card>
  </SettingsPanel>
)

// ── 能接的面板 ─────────────────────────────────────────────────────────

/** 关于：pi 版本 + 路径。数据源 pi_auth_status / package.json。 */
const AboutPanel = () => {
  const { t } = useT()
  const [auth, setAuth] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    invoke<Record<string, unknown>>('pi_auth_status')
      .then(setAuth)
      .catch((e) => console.error('[settings] auth status 拉取失败', e))
  }, [])
  return (
    <SettingsPanel title={t('nav.settings')} description="About this build">
      <Card>
        <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
          <dt className="text-muted-foreground">pi auth path</dt>
          <dd className="font-mono text-xs break-all">{String(auth?.authPath ?? '—')}</dd>
          <dt className="text-muted-foreground">settings.json</dt>
          <dd className="font-mono text-xs break-all">{String(auth?.settingsPath ?? '—')}</dd>
          <dt className="text-muted-foreground">models.json</dt>
          <dd className="font-mono text-xs break-all">{String(auth?.modelsPath ?? '—')}</dd>
        </dl>
      </Card>
    </SettingsPanel>
  )
}

// ── 面板映射 ───────────────────────────────────────────────────────────
/** 引擎侧缺数据的面板（UI 保留 + 标注）。 */
const GAPS: Record<string, string> = {
  account: 'pi 无云账号体系（AccountPanel 调 openhuman 的 auth/账号 RPC）。',
  privacy: 'pi 无 privacy_mode 配置项。',
  migration: 'pi 无 openhuman 的数据迁移面。',
  'recovery-phrase': 'pi 无加密钱包/助记词能力。',
  'wallet-balances': 'pi 无加密钱包能力。',
  embeddings: 'pi 无 embeddings（向量嵌入）能力。',
  meetings: 'pi 无会议集成。',
  'sandbox-settings': 'pi 无沙箱配置面（沙箱由其 process 隔离实现，无运行时开关）。',
  'agent-access': 'pi 无 agent OS access 分层（tiers/approvals/rate limits）。',
  'tool-policy-diagnostics': 'pi 无 tool_policy 诊断 RPC。',
  'approval-history': 'pi 的 ApprovalRegistry 只持 pending，无历史持久化。',
  'event-log': 'pi 无 core 事件日志 RPC（AG-UI 事件流可桥接，但非同一面）。',
  voice: 'pi 有 tts 工具，但无 voiceSettings（供应商/路由/预设）。',
  security: 'pi 无 keyring 抽象（凭据走 ~/.pi/auth.json）。',
}

export function SettingsPage({ onClose }: { onClose?: () => void }) {
  const { currentRoute } = useSettingsNavigation()
  const { setOnClose } = useMemo(
    () => ({
      setOnClose: (fn: (() => void) | null) =>
        import('./hooks/useSettingsNavigation').then((m) => m.settingsNavStore.getState().setOnClose(fn)),
    }),
    [],
  )
  useEffect(() => {
    void setOnClose(onClose ?? null)
    return () => {
      void setOnClose(null)
    }
  }, [onClose, setOnClose])

  const entry = findEntryById(currentRoute)
  const title = entry ? entry.id : currentRoute
  const gap = GAPS[currentRoute]

  return (
    <SettingsLayout>
      {gap !== undefined ? (
        <EngineGapPanel title={title} why={gap} />
      ) : currentRoute === 'about' ? (
        <AboutPanel />
      ) : (
        <SettingsPanel title={title} description="No data source wired yet for this panel.">
          <Card>
            <Notice kind="neutral">
              该面板已移植 UI，数据面尚未接（见 docs/openhuman-migration-plan.md 第 2 类）。
            </Notice>
          </Card>
        </SettingsPanel>
      )}
    </SettingsLayout>
  )
}
