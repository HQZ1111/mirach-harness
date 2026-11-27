/**
 * 软件内更新（2026-11-27 用户："能进行软件内更新推送吗？"）。
 *
 * 数据面 = Tauri updater 插件：配置里的 endpoint 指向 GitHub Releases 的
 * `latest.json`，Rust 侧下载安装包并用内置公钥校验 minisign 签名
 * （`tauri.conf.json` 的 `plugins.updater`）。前端只负责状态机与文案。
 *
 * 版本来源：GitHub Release 资产 `latest.json`（发布脚本生成）；
 * 安装：NSIS 静默安装完成后应用退出，这里再调 `relaunch()` 兜底。
 *
 * 自动检查偏好：localStorage `mirach:update.auto-check.v1`（默认关）。
 * **只自动检查、发系统通知，不自动安装**——安装必须用户在设置页确认
 * （避免后台静默替换用户正在用的程序）。
 */
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'

const AUTO_CHECK_KEY = 'mirach:update.auto-check.v1'

export function autoCheckEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_CHECK_KEY) === '1'
  } catch (e) {
    console.error('[updater] 读取自动检查偏好失败', e)
    return false
  }
}

export function setAutoCheckEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(AUTO_CHECK_KEY, '1')
    else localStorage.removeItem(AUTO_CHECK_KEY)
  } catch (e) {
    console.error('[updater] 写入自动检查偏好失败', e)
  }
}

/** 检查远端版本；null = 已是最新。错误原样抛给调用方展示。 */
export async function checkForUpdate(): Promise<Update | null> {
  return await check({ timeout: 20_000 })
}

export interface UpdateProgress {
  /** 已下载字节。 */
  downloaded: number
  /** 总字节；服务端没给 content-length 时 null。 */
  total: number | null
}

/** 下载并安装；Windows 上安装器接管后应用会退出。 */
export async function installUpdate(
  update: Update,
  onProgress: (progress: UpdateProgress) => void,
): Promise<void> {
  let downloaded = 0
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      onProgress({ downloaded: 0, total: event.data.contentLength ?? null })
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
      onProgress({ downloaded, total: null })
    }
  })
  // Windows NSIS 安装通常已让进程退出；走到这里说明还活着（例如安装器
  // 失败退回了），再 relaunch 一次确保新版本启动。失败要可见。
  await relaunch()
}
