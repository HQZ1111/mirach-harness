/**
 * 界面偏好（语言 / 时区）——openhuman 偏好卡的宿主等价面（2026-10-25）。
 *
 * 上游（openhuman app/src/store/localeSlice.ts + LanguageSelect.tsx）：
 * 语言走 redux-persist → localStorage `persist:locale`，只存 `{current}`；
 * 时区在仓库快照里**不存在**（无组件/无 key/无常量表）——用户要求补上，
 * 按同一套 localStorage 偏好语义实现（不发明 Rust 侧配置面）。
 *
 * 宿主键名换 mirach 前缀（与 notification-prefs / completion-sound 一致）：
 *   · `mirach:locale`   = 'zh-CN' | 'en'
 *   · `mirach:timezone` = IANA 名（'Asia/Shanghai'）或 'device'
 *
 * 语言只留中文 + 英文（用户 2026-10-25 定稿；上游 16 种）。
 *
 * **当前生效范围（如实）**：选择持久化、驱动 `<html lang>` 与日期/时间
 * 格式化；界面文案本身仍是硬编码中文（宿主 i18n 未建，src/i18n 只有
 * .gitkeep）——设置页行下用 note 明示，不假装全站已翻译。
 */

export const LOCALES = ['zh-CN', 'en'] as const
export type AppLocale = (typeof LOCALES)[number]

/** 语言选项（上游 LanguageSelect 的 flag + label 形态，只留两种）。 */
export const LOCALE_OPTIONS: readonly { value: AppLocale; flag: string; label: string }[] = [
  { value: 'zh-CN', flag: '🇨🇳', label: '简体中文' },
  { value: 'en', flag: '🇬🇧', label: 'English' },
]

const LOCALE_KEY = 'mirach:locale'
const TIMEZONE_KEY = 'mirach:timezone'

/** 设备时区（Intl 的 IANA 名；取不到时回落 UTC 并如实返回）。 */
export function deviceTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof tz === 'string' && tz !== '' ? tz : 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 时区清单：系统支持的 IANA 名（上游无此表——见文件头）。 */
export function timezoneOptions(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
    .supportedValuesOf
  if (typeof supported === 'function') {
    try {
      return supported('timeZone')
    } catch {
      // 某些运行时不支持该 key：落到"只列设备时区"的诚实降级
    }
  }
  return [deviceTimeZone()]
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch (e) {
    // 存储不可用 = 读不到偏好（不静默假装成功，调用方看到 null 走默认）
    console.error(`[prefs] localStorage 读取失败（${key}）`, e)
    return null
  }
}

function writeRaw(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch (e) {
    console.error(`[prefs] localStorage 写入失败（${key}）`, e)
  }
}

/** 当前语言（未设置时按 navigator.language 推断，同上游 localeSlice）。 */
export function readLocale(): AppLocale {
  const raw = readRaw(LOCALE_KEY)
  if (raw === 'zh-CN' || raw === 'en') return raw
  const nav = typeof navigator !== 'undefined' ? navigator.language : ''
  return nav.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

export function setLocalePref(locale: AppLocale): void {
  writeRaw(LOCALE_KEY, locale)
  // 与上游 I18nContext 同款副作用：同步 <html lang>（上游还同步 dir，
  // 这里只有中英两种 LTR，无 rtl 需求）。
  try {
    document.documentElement.lang = locale
  } catch (e) {
    console.error('[prefs] <html lang> 同步失败', e)
  }
}

/** 当前时区选择：'device' = 跟随设备（默认，同上游文案语义）。 */
export function readTimezone(): string {
  const raw = readRaw(TIMEZONE_KEY)
  return raw === null || raw === '' ? 'device' : raw
}

export function setTimezonePref(tz: string): void {
  writeRaw(TIMEZONE_KEY, tz)
}

/** 实际生效的 IANA 时区（'device' → 设备时区）。 */
export function effectiveTimeZone(): string {
  const pref = readTimezone()
  return pref === 'device' ? deviceTimeZone() : pref
}
