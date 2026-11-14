/**
 * account-settings —— OpenHuman「设置 → 通用 → 账户」的移植（2026-10-25）。
 *
 * 源（openhuman app/src/components/）：
 *   settings/panels/AccountPanel.tsx（121 行）·
 *   settings/LogoutAndClearActions.tsx（167 行）·
 *   ui/{Card,Field,TileGrid,Button}.tsx（结构原语）
 *
 * 结构逐块对应上游（不是精简版）：
 *   TileGrid(2) ┬ Card[签名至 Mirach] → 套餐与账单 + 「打开控制台」外链按钮
 *               └ （上游第二格是「偏好」卡 —— 用户 2026-10-25 定稿：
 *                  偏好不要，语言/时区移到「基础设置 → 常规」）
 *   Card[会话]  → 退出登录 / 清除应用数据（危险色 + 二次确认对话框）
 *
 * ── 与上游的差异（都是宿主事实，各有就地注释）──────────────────────
 * · 套餐徽章 / 用量进度条 / 「使用此循环」：上游数据来自 cloud 订阅 API
 *   （useUsageState → /billing）。宿主没有云端账户与用量服务——整块不渲染
 *   （不是渲染成 0 或 "Free" 的假数据；铁律 12）。
 * · 「签名至」文案：上游是 `settings.account.signedIn` = "签名至 OpenHuman"，
 *   按用户要求换成 "签名至 Mirach"。宿主无账户，副行显示本机标识。
 * · 退出登录 / 清除数据：上游调 auth_logout / reset_local_data + restart_app。
 *   宿主对应面见 handlers 注释——真实删除本机数据，不做假动作。
 * · 文案硬编码中文（宿主设置页无 i18n，见文件头 AGENTS.md 规矩 2）。
 *
 * 视觉：上游用 shadcn 令牌（text-content / bg-surface / border-line），
 * 宿主用 `.set-*` 类 + --text-* / --stroke / --surface 令牌。**结构与间距
 * 照上游**（卡片圆角 12、行内 padding 16/12、标题 12px 半粗），配色接
 * 宿主令牌——与「颜色必须接回 mirach 令牌」的既有纪律一致。
 */

import { ExternalLink, LogOut, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { invoke } from '@tauri-apps/api/core'

import { inTauri } from '@/lib/tauri-window'

/** 上游 utils/links.ts:3 的常量，用户指定"先用 openhuman 的地址，后面再换"。 */
const BILLING_DASHBOARD_URL = 'https://tinyhumans.ai/dashboard'

/** 与 settings-overlay.tsx 同款 IPC 错误翻译（浏览器直开时给出可读原因）。 */
function describeIpcError(e: unknown): string {
  if (!inTauri) {
    return '浏览器直开模式：没有桌面宿主后端，设置项不可读写（打包后的桌面应用里可用）'
  }
  const msg = e instanceof Error ? e.message : String(e)
  return msg
}

/** 上游 Field 的行结构（label + description 左，control 右；窄屏堆叠）。 */
function Field({
  label,
  description,
  control,
}: {
  label: string
  description?: string
  control: React.ReactNode
}) {
  return (
    <div className="set-acct-field">
      <div className="set-acct-field-text">
        <span className="set-acct-field-label">{label}</span>
        {description !== undefined && <p className="set-acct-field-desc">{description}</p>}
      </div>
      <div className="set-acct-field-control">{control}</div>
    </div>
  )
}

/** 上游 Card：可选分组标题 + 分隔行（divide-y）。 */
function Card({
  title,
  children,
  className,
}: {
  title?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={className === undefined ? 'set-acct-card' : `set-acct-card ${className}`}>
      {title !== undefined && <div className="set-acct-card-head">{title}</div>}
      <div className="set-acct-card-body">{children}</div>
    </div>
  )
}

/** 上游 TileGrid columns=2：窄屏单列，≥md 两列。 */
function TileGrid({ children }: { children: React.ReactNode }) {
  return <div className="set-acct-grid">{children}</div>
}

// ── 退出登录 / 清除应用数据（上游 LogoutAndClearActions.tsx）────────

function LogoutAndClearActions({
  onCleared,
}: {
  /** 清除数据后让外层重拉状态（上游是 restart_app，宿主改为就地重置）。 */
  onCleared: () => void
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [isLoggingOut, setIsLoggingOut] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 退出登录 = 清空全部提供方凭据（auth.json 的 per-provider 条目）。
  // 宿主没有账户体系：唯一等价"登录态"就是各提供方的 OAuth / API 密钥。
  // 上游 auth_logout 清的是云端 session；这里清本机凭据，不碰会话/设置/
  // 密码库——重新登录（设置 → 模型 → 账号）即可恢复。
  const handleLogout = useCallback(async () => {
    setError(null)
    setIsLoggingOut(true)
    try {
      const status = await invoke<{ providers: { provider: string; configured: boolean; source: string }[] }>(
        'pi_auth_status',
      )
      const configured = status.providers.filter((p) => p.configured && p.source === 'auth')
      if (configured.length === 0) {
        setError('没有已保存的凭据——无需退出登录。')
        return
      }
      for (const p of configured) {
        await invoke<boolean>('pi_delete_provider_key', { provider: p.provider })
      }
      onCleared()
    } catch (e) {
      console.error('[account] 退出登录失败', e)
      setError('退出登录失败，请重试。')
    } finally {
      setIsLoggingOut(false)
    }
  }, [onCleared])

  // 清除应用数据 = 真删本机数据（上游 reset_local_data + restart_app）。
  // 宿主对应面 = pi_vault 全部条目 + 全部提供方凭据。会话 JSONL / 设置文件
  // 属于用户资产，**不删**（上游文案列的"对话/工作空间"在宿主是用户数据，
  // 误删不可逆——这里只清凭据与密码库，对话框文案已按宿主事实改写）。
  const handleClearData = useCallback(async () => {
    setIsClearing(true)
    setError(null)
    try {
      const status = await invoke<{ providers: { provider: string; configured: boolean; source: string }[] }>(
        'pi_auth_status',
      )
      for (const p of status.providers.filter((r) => r.configured && r.source === 'auth')) {
        await invoke<boolean>('pi_delete_provider_key', { provider: p.provider })
      }
      const vault = await invoke<{ items: { id: string }[] }>('pi_vault_list')
      for (const item of vault.items) {
        await invoke<boolean>('pi_vault_remove', { id: item.id })
      }
      setConfirmOpen(false)
      onCleared()
    } catch (e) {
      console.error('[account] 清除数据失败', e)
      setError(describeIpcError(e))
    } finally {
      setIsClearing(false)
    }
  }, [onCleared])

  return (
    <>
      <Card title="会话">
        <Field
          control={
            <button
              className="set-btn"
              disabled={isLoggingOut}
              onClick={() => void handleLogout()}
              type="button"
            >
              <LogOut aria-hidden size={14} />
              {isLoggingOut ? '正在退出…' : '退出登录'}
            </button>
          }
          description="退出当前账户"
          label="退出登录"
        />
        {!confirmOpen && error !== null && <div className="set-acct-row-error">{error}</div>}
        <Field
          control={
            <button
              className="set-btn set-btn-danger"
              onClick={() => setConfirmOpen(true)}
              type="button"
            >
              <Trash2 aria-hidden size={14} />
              清除数据
            </button>
          }
          description="退出登录并永久清除所有本地应用数据 此操作无法撤销。"
          label="清除应用数据"
        />
      </Card>

      {/* 二次确认（上游 AlertDialogRoot：点外部不关闭、确认后不自动收起，
          进度与失败都留在对话框里）。 */}
      {confirmOpen && (
        <div className="set-acct-dialog-backdrop" role="presentation">
          <div
            aria-describedby="acct-clear-desc"
            aria-labelledby="acct-clear-title"
            aria-modal="true"
            className="set-acct-dialog"
            role="alertdialog"
          >
            <h4 className="set-acct-dialog-title" id="acct-clear-title">
              清除应用数据
            </h4>
            <div className="set-acct-dialog-desc" id="acct-clear-desc">
              <p>这将退出你的账户并永久删除本地应用数据，包括：</p>
              <ul>
                <li>所有提供方凭据（OAuth 登录与 API 密钥）</li>
                <li>密码库中保存的全部条目</li>
              </ul>
              <p className="set-acct-dialog-irreversible">此操作不可撤销。</p>
              <p className="set-acct-dialog-note">
                会话记录、设置文件与工作区数据不在清除范围内——它们是用户资产。
              </p>
            </div>
            {error !== null && <div className="set-err">{error}</div>}
            <div className="set-acct-dialog-footer">
              <button
                className="set-btn"
                disabled={isClearing}
                onClick={() => {
                  setConfirmOpen(false)
                  setError(null)
                }}
                type="button"
              >
                取消
              </button>
              <button
                className="set-btn set-btn-danger"
                disabled={isClearing}
                onClick={() => void handleClearData()}
                type="button"
              >
                {isClearing ? '正在清除应用数据...' : '清除应用数据'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

// ── 账户页根组件（上游 AccountPanel.tsx）─────────────────────────────

export function AccountSettings() {
  const [configuredCount, setConfiguredCount] = useState<number | null>(null)

  const refresh = useCallback(() => {
    if (!inTauri) {
      setConfiguredCount(0)
      return
    }
    void invoke<{ providers: { configured: boolean; source: string }[] }>('pi_auth_status')
      .then((r) => setConfiguredCount(r.providers.filter((p) => p.configured && p.source === 'auth').length))
      .catch((e) => {
        console.error('[account] 凭据状态读取失败', e)
        setConfiguredCount(null)
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <section className="set-section">
      {/* 上游 SettingsPanel 的副标题（标题由右栏 inset 头承担） */}
      <p className="set-hint">你的个人资料、套餐以及此设备上的会话。</p>

      <TileGrid>
        <Card className="set-acct-card--profile">
          <div className="set-acct-profile-row">
            <div className="set-acct-profile-text">
              <div className="set-acct-profile-name">Mirach Harness</div>
              <div className="set-acct-profile-sub">签名至 Mirach</div>
            </div>
            {/* 上游此处是套餐 Badge（FREE / Pro …），数据来自云端订阅——
                宿主无云端账户，不渲染假徽章。 */}
          </div>

          <Field
            control={
              <button
                className="set-btn"
                onClick={() => {
                  void invoke('terminal_open_url', { url: `${BILLING_DASHBOARD_URL}?tab=billing` }).catch(
                    (e: unknown) => {
                      console.error('[account] 打开控制台失败', e)
                    },
                  )
                }}
                type="button"
              >
                打开控制台
                <ExternalLink aria-hidden size={14} />
              </button>
            }
            description="管理你的订阅、额度和发票"
            label="套餐与账单"
          />

          <p className="set-acct-note">
            本宿主没有云端账户与订阅服务（凭据只存本机）——「打开控制台」打开的是
            OpenHuman 的账单页，待替换为 Mirach 自己的地址。
            {configuredCount !== null && ` 本机已配置 ${configuredCount} 个提供方凭据。`}
          </p>
        </Card>
      </TileGrid>

      <LogoutAndClearActions onCleared={refresh} />
    </section>
  )
}
