/**
 * `@hermes/shared` 的宿主对偶（上游 `apps/shared/src/`）。
 *
 * 上游这个包放「前后端共享的纯逻辑」（JSON-RPC 帧解析、ansi 处理等）。
 * 宿主只用到一个函数 `jsonRpcErrorFromFrame`，这里给最小实现。
 */

/** 从一个 JSON-RPC 帧里提取错误（上游 `shared/src/jsonrpc.ts`）。 */
export function jsonRpcErrorFromFrame(frame: unknown): null | { code: number; message: string; data?: unknown } {
  if (!frame || typeof frame !== 'object') return null
  const error = (frame as { error?: unknown }).error
  if (!error || typeof error !== 'object') return null
  const e = error as { code?: unknown; message?: unknown; data?: unknown }
  if (typeof e.code !== 'number' || typeof e.message !== 'string') return null
  return { code: e.code, message: e.message, data: e.data }
}

/**
 * 紧凑数字（上游 `apps/shared/src/format.ts`，逐字移植）。
 *
 * 所有面向用户的计数/token 数字都走这里：999 → "999"，1000 → "1k"，
 * 1230 → "1.2k"，10_000 → "10k"，1_500_000 → "1.5M"。M 是最高档。
 */
export function compactNumber(value: null | number | undefined): string {
  const num = Number(value ?? 0)
  if (!Number.isFinite(num) || num <= 0) return '0'
  const scaled = (v: number, suffix: string) => `${v.toFixed(1).replace(/\.0$/, '')}${suffix}`
  // 阈值略低于单位边界，避免四舍五入产出 "1000k"。
  if (num >= 999_950) return scaled(num / 1_000_000, 'M')
  if (num >= 999.5) return scaled(num / 1_000, 'k')
  return `${Math.round(num)}`
}
