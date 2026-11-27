/**
 * 设置 →「版本与更新」（2026-11-27 重做：去掉 hermes 文案 + 接真更新）。
 *
 * 数据面：
 *   · 版本 = package.json（与安装包一致）；
 *   · 检查/下载/安装 = `src/lib/app-updater.ts`（Tauri updater 插件，
 *     endpoint = GitHub Releases 的 latest.json，minisign 签名校验）；
 *   · 运行信息 = 引擎版本（`pi_engine_version`）与 settings/models/auth
 *     三个真实文件路径（`pi_auth_status`）；
 *   · 数据目录 = `pi_data_dir_get/set/reveal`（agent home 覆盖，下次启动生效）。
 *
 * 更新状态机：idle → checking → latest / available → installing → 退出重启
 * （Windows 安装器接管）。失败全部落在 error 状态并显示原因，不假装成功。
 * 自动检查 = 启动时后台检查并发系统通知（`update-boot-check.tsx`），
 * **不自动安装**。
 */
import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import type { Update } from '@tauri-apps/plugin-updater'
import { FolderOpen, RefreshCw } from 'lucide-react'

import pkg from '../../../package.json'
import { Switch } from '@/components/ui/switch'
import {
  autoCheckEnabled,
  checkForUpdate,
  installUpdate,
  setAutoCheckEnabled,
  type UpdateProgress,
} from '@/lib/app-updater'

interface PiAuthStatus {
  authPath: string
  modelsPath: string
  settingsPath: string
}

interface DataDirInfo {
  current: string
  defaultDir: string
  configured: string | null
  envOverride: string | null
}

type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest'; version: string }
  | { kind: 'available'; update: Update; version: string; notes?: string; date?: string }
  | { kind: 'installing'; version: string; progress: UpdateProgress }
  | { kind: 'error'; message: string }

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function statusText(state: UpdateState, currentVersion: string): { label: string; desc: string } {
  switch (state.kind) {
    case 'idle':
      return {
        label: '尚未检查',
        desc: '从 GitHub Releases 检查是否有新版本。安装包带数字签名，下载后自动校验。',
      }
    case 'checking':
      return { label: '正在检查…', desc: '正在读取 GitHub Releases 的最新版本信息。' }
    case 'latest':
      return {
        label: '已是最新版本',
        desc: `当前 v${state.version}，远端没有更新的稳定版。`,
      }
    case 'available':
      return {
        label: `发现新版本 v${state.version}`,
        desc: state.date
          ? `当前 v${currentVersion} · 发布日期 ${state.date}`
          : `当前 v${currentVersion}。`,
      }
    case 'installing': {
      const { downloaded, total } = state.progress
      const percent =
        total !== null && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : null
      return {
        label: `正在安装 v${state.version}`,
        desc:
          percent !== null && total !== null
            ? `下载中 ${percent}%（${formatMb(downloaded)} / ${formatMb(total)}）`
            : `下载中 ${formatMb(downloaded)}…`,
      }
    }
    case 'error':
      return { label: '更新失败', desc: state.message }
  }
}

export function UpdatesSettings() {
  const [state, setState] = useState<UpdateState>({ kind: 'idle' })
  const [autoCheck, setAutoCheck] = useState(() => autoCheckEnabled())
  const [engineVersion, setEngineVersion] = useState<string | null>(null)
  const [engineError, setEngineError] = useState<string | null>(null)
  const [auth, setAuth] = useState<PiAuthStatus | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [dataDir, setDataDir] = useState<DataDirInfo | null>(null)
  const [dataDirError, setDataDirError] = useState<string | null>(null)
  const [dataDirNotice, setDataDirNotice] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void invoke<string>('pi_engine_version')
      .then((v) => {
        if (!cancelled) setEngineVersion(v)
      })
      .catch((e: unknown) => {
        console.error('[updates] 引擎版本读取失败', e)
        if (!cancelled) setEngineError(describeError(e))
      })
    void invoke<PiAuthStatus>('pi_auth_status')
      .then((v) => {
        if (!cancelled) setAuth(v)
      })
      .catch((e: unknown) => {
        console.error('[updates] 配置文件路径读取失败', e)
        if (!cancelled) setAuthError(describeError(e))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const refreshDataDir = useCallback(async () => {
    try {
      const info = await invoke<DataDirInfo>('pi_data_dir_get')
      setDataDir(info)
      setDataDirError(null)
    } catch (e) {
      console.error('[updates] 数据目录读取失败', e)
      setDataDirError(describeError(e))
    }
  }, [])

  useEffect(() => {
    void refreshDataDir()
  }, [refreshDataDir])

  const closeAvailableUpdate = useCallback(
    (next: UpdateState) => {
      if (state.kind === 'available') {
        void state.update.close().catch((e) => console.error('[updates] 释放更新资源失败', e))
      }
      setState(next)
    },
    [state],
  )

  const checkNow = useCallback(async () => {
    closeAvailableUpdate({ kind: 'checking' })
    try {
      const update = await checkForUpdate()
      if (!update) {
        setState({ kind: 'latest', version: pkg.version })
        return
      }
      setState({
        kind: 'available',
        update,
        version: update.version,
        notes: update.body,
        date: update.date,
      })
    } catch (e) {
      console.error('[updates] 检查更新失败', e)
      setState({ kind: 'error', message: `检查更新失败：${describeError(e)}` })
    }
  }, [closeAvailableUpdate])

  const startInstall = useCallback(async () => {
    if (state.kind !== 'available') return
    const update = state.update
    setState({
      kind: 'installing',
      version: update.version,
      progress: { downloaded: 0, total: null },
    })
    try {
      await installUpdate(update, (progress) => {
        setState((current) =>
          current.kind === 'installing'
            ? { ...current, progress: { downloaded: progress.downloaded, total: progress.total ?? current.progress.total } }
            : current,
        )
      })
      // 正常路径：Windows 安装器让进程退出，这里不会执行。
    } catch (e) {
      console.error('[updates] 安装更新失败', e)
      setState({ kind: 'error', message: `安装更新失败：${describeError(e)}` })
    }
  }, [state])

  const chooseDataDir = useCallback(async () => {
    setDataDirNotice(null)
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: '选择数据目录（技能 / 插件 / 会话 / 配置）',
      })
      if (typeof picked !== 'string') return
      await invoke('pi_data_dir_set', { agentDir: picked })
      await refreshDataDir()
      setDataDirNotice('已保存。重启 Mirach Harness 后生效；现有数据不会自动搬过去。')
    } catch (e) {
      console.error('[updates] 设置数据目录失败', e)
      setDataDirError(describeError(e))
    }
  }, [refreshDataDir])

  const resetDataDir = useCallback(async () => {
    setDataDirNotice(null)
    try {
      await invoke('pi_data_dir_set', { agentDir: null })
      await refreshDataDir()
      setDataDirNotice('已恢复默认目录。重启 Mirach Harness 后生效。')
    } catch (e) {
      console.error('[updates] 恢复默认数据目录失败', e)
      setDataDirError(describeError(e))
    }
  }, [refreshDataDir])

  const revealDataDir = useCallback(() => {
    void invoke('pi_data_dir_reveal').catch((e: unknown) => {
      console.error('[updates] 打开数据目录失败', e)
      setDataDirError(describeError(e))
    })
  }, [])

  const status = statusText(state, pkg.version)
  const busy = state.kind === 'checking' || state.kind === 'installing'

  return (
    <section className="set-section">
      <div className="set-about-hero set-about-hero--center">
        <img alt="Mirach Harness" className="set-about-logo set-about-logo--lg" src="/brand/logo.png" />
        <div>
          <div className="set-about-name">{pkg.productName}</div>
          <div className="set-row-env">版本 {pkg.version}</div>
        </div>
      </div>

      <div className="set-acct-card">
        <div className="set-acct-card-head">更新</div>
        <div className="set-acct-card-body">
          <div className="set-acct-field">
            <div className="set-acct-field-text">
              <span className="set-acct-field-label">{status.label}</span>
              <p className="set-acct-field-desc">{status.desc}</p>
              {state.kind === 'available' && state.notes ? (
                <p className="set-hint max-h-28 overflow-y-auto whitespace-pre-wrap">{state.notes}</p>
              ) : null}
            </div>
            <div className="set-acct-field-control">
              <div className="set-actions">
                <button
                  className="set-btn"
                  disabled={busy}
                  onClick={() => void checkNow()}
                  type="button"
                >
                  <RefreshCw className={state.kind === 'checking' ? 'size-3.5 animate-spin' : 'size-3.5'} />
                  检查更新
                </button>
                <button
                  className="set-btn set-btn-primary"
                  disabled={state.kind !== 'available'}
                  onClick={() => void startInstall()}
                  type="button"
                >
                  {state.kind === 'installing' ? '正在更新…' : '立即更新'}
                </button>
              </div>
            </div>
          </div>
          {state.kind === 'error' && <div className="set-err">{state.message}</div>}

          <div className="set-acct-field">
            <div className="set-acct-field-text">
              <span className="set-acct-field-label">启动时自动检查更新</span>
              <p className="set-acct-field-desc">
                启动后在后台检查 GitHub Releases；发现新版本发一条系统通知，安装仍需你在本页确认。
              </p>
            </div>
            <div className="set-acct-field-control">
              <Switch
                aria-label="启动时自动检查更新"
                checked={autoCheck}
                onCheckedChange={(on) => {
                  setAutoCheckEnabled(on)
                  setAutoCheck(on)
                }}
              />
            </div>
          </div>

          <div className="set-acct-field">
            <div className="set-acct-field-text">
              <span className="set-acct-field-label">更新渠道</span>
              <p className="set-acct-field-desc">稳定版：GitHub Releases 的 latest.json（主分支构建）。</p>
            </div>
            <div className="set-acct-field-control">
              <span className="set-code">稳定版（唯一）</span>
            </div>
          </div>
        </div>
      </div>

      <h4 className="set-sub-title">运行信息</h4>
      <div className="set-acct-card">
        <div className="set-acct-card-body">
          <dl className="set-about-defs" style={{ padding: '12px 16px' }}>
            <dt>应用名</dt>
            <dd>
              {pkg.productName}（{pkg.name}）
            </dd>
            <dt>应用版本</dt>
            <dd>{pkg.version}</dd>
            <dt>引擎版本</dt>
            <dd>{engineVersion ?? (engineError ? `读取失败：${engineError}` : '…')}</dd>
            {auth !== null && (
              <>
                <dt>settings</dt>
                <dd className="set-row-env">{auth.settingsPath}</dd>
                <dt>models</dt>
                <dd className="set-row-env">{auth.modelsPath}</dd>
                <dt>auth</dt>
                <dd className="set-row-env">{auth.authPath}</dd>
              </>
            )}
            {authError !== null && (
              <>
                <dt>配置文件</dt>
                <dd className="set-row-env">读取失败：{authError}</dd>
              </>
            )}
          </dl>
        </div>
      </div>

      <div className="set-acct-card">
        <div className="set-acct-card-head">数据目录</div>
        <div className="set-acct-card-body">
          <div className="set-acct-field">
            <div className="set-acct-field-text">
              <span className="set-acct-field-label">技能 / 插件 / 会话 / 配置的存放位置</span>
              <p className="set-acct-field-desc">
                默认在用户目录（C 盘）的 <span className="set-code">~/.rpi/agent</span>
                ；安装在其他盘时数据也不会跟着安装目录走。可以改到任意盘，下次启动生效；
                <strong>不会移动或删除现有数据</strong>。
              </p>
              {dataDir === null ? (
                <p className="set-hint">读取中…</p>
              ) : (
                <>
                  <p className="set-hint">
                    当前：<span className="set-code">{dataDir.current}</span>
                  </p>
                  <p className="set-hint">
                    默认：<span className="set-code">{dataDir.defaultDir}</span>
                    {dataDir.envOverride !== null ? ' · 环境变量 RPI_CODING_AGENT_DIR 生效中，应用内设置被忽略' : ''}
                  </p>
                </>
              )}
              {dataDirError !== null && <div className="set-err">{dataDirError}</div>}
              {dataDirNotice !== null && <p className="set-hint">{dataDirNotice}</p>}
            </div>
            <div className="set-acct-field-control">
              <div className="set-actions">
                <button className="set-btn" onClick={revealDataDir} type="button">
                  <FolderOpen className="size-3.5" />
                  打开目录
                </button>
                <button
                  className="set-btn"
                  disabled={Boolean(dataDir?.envOverride)}
                  onClick={() => void chooseDataDir()}
                  type="button"
                >
                  更改…
                </button>
                <button
                  className="set-btn"
                  disabled={dataDir === null || dataDir.configured === null || Boolean(dataDir.envOverride)}
                  onClick={() => void resetDataDir()}
                  type="button"
                >
                  恢复默认
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
