// ── 内容寻址高亮缓存（hermes shiki-highlight-cache.ts 同款，泛型化）─────────
// 切到热会话会重挂载整份转录，每个挂载的代码块都要从头 tokenize 一遍——
// 即便内容一个字没变。修法：模块级 LRU，键 = (scope, language, code)，
// 值 = 高亮结果；重挂载的旧块同步命中缓存上色，完全不碰 highlighter。
//
// 与 hermes 的差异：hermes 缓存 HTML 字符串（dangerouslySetInnerHTML 上屏，
// 体量 = html 长度）；本工程铁律「永不 innerHTML」，高亮结果是 React 元素树，
// 体量按源代码长度计（元素树约为源码的 5-10 倍，容量上限按此折算）。
//
// 本模块刻意零依赖（无 React、无 react-shiki），缓存逻辑可独立单测。

/** 上限：条数。 */
export const HIGHLIGHT_CACHE_MAX_ENTRIES = 512
/** 上限：缓存内容计的源码字符总量（React 元素树约 5-10 倍于此，见上）。 */
export const HIGHLIGHT_CACHE_MAX_CHARS = 1024 * 1024

/** 一个高亮块的唯一键：scope + language + 逐字代码。 */
export function highlightCacheKey(scope: string, language: string, code: string): string {
  return `${scope}\u0000${language}\u0000${code}`
}

/**
 * 有界 LRU：键 → 值。get 刷新新近度（Map 插入序即 LRU 时钟）；set 逐出最旧
 * 条目直到条数与总量两个上限同时满足。size 由调用方在 set 时声明（本工程的
 * 值是 React 元素树，自身不可廉价测长）。
 */
export class HighlightCache<T> {
  private readonly entries = new Map<string, { value: T; size: number }>()
  private chars = 0

  constructor(
    private readonly maxEntries: number = HIGHLIGHT_CACHE_MAX_ENTRIES,
    private readonly maxChars: number = HIGHLIGHT_CACHE_MAX_CHARS,
  ) {}

  get size(): number {
    return this.entries.size
  }

  get totalChars(): number {
    return this.chars
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key)

    if (entry !== undefined) {
      // 刷新新近度：删了重插，把条目挪到最新位。
      this.entries.delete(key)
      this.entries.set(key, entry)
    }

    return entry?.value
  }

  set(key: string, value: T, size: number): void {
    const existing = this.entries.get(key)

    if (existing) {
      this.chars -= existing.size
      this.entries.delete(key)
    }

    this.entries.set(key, { value, size })
    this.chars += size
    this.evict()
  }

  clear(): void {
    this.entries.clear()
    this.chars = 0
  }

  private evict(): void {
    while (
      (this.entries.size > this.maxEntries || this.chars > this.maxChars) &&
      this.entries.size > 0
    ) {
      const oldestKey = this.entries.keys().next().value as string
      const oldest = this.entries.get(oldestKey)!
      this.entries.delete(oldestKey)
      this.chars -= oldest.size
    }
  }
}
