/**
 * i18n 影子层（用户决定：**不做多语言**，固定英文）。
 *
 * openhuman 的 settings 文件全部 `useT()`。为让它们原样编译运行，这里提供
 * 同名同签名的最小实现：`t(key, fallback?)` 查 en 字典，缺失回落 fallback
 * → key 本身。**没有 provider、没有 locale 切换**（不做语言）。
 *
 * 与 openhuman 的差异：无 `I18nProvider` 包装需求（useT 直接读模块级字典），
 * 因此任何组件都能独立渲染/单测。
 */
import en from './en'

const dict: Record<string, string> = en

/** 查词条：缺失 → fallback → key 本身（与 openhuman 语义一致）。 */
export function translate(key: string, fallback?: string): string {
  const hit = dict[key]
  if (hit !== undefined) return hit
  return fallback ?? key
}

/** openhuman `useT()` 的对位（不做 locale 状态，故无需 hook 语义）。 */
export function useT(): { t: (key: string, fallback?: string) => string; locale: 'en' } {
  return { t: translate, locale: 'en' }
}

export type Locale = 'en'
