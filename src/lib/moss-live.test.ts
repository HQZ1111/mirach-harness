import { describe, expect, it } from 'vitest'

import { pcm16ToBase64 } from './moss-live'

/**
 * 上行的坑（2026-11-15 真机）：把 Int16 采样值直接塞给
 * `String.fromCharCode` 再 `btoa`，值 > 255 时抛 InvalidCharacterError，
 * 音频一帧都发不出去。这里锁住"按小端字节编码"的行为。
 */
describe('pcm16ToBase64', () => {
  const decode = (b64: string): number[] =>
    [...atob(b64)].map((c) => c.charCodeAt(0))

  it('encodes little-endian bytes of every sample', () => {
    const samples = new Int16Array([0, 1, 255, 256, 1000, -1, -32768, 32767])
    expect(decode(pcm16ToBase64(samples))).toEqual([
      ...new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
    ])
  })

  it('handles a subarray view (byteOffset respected)', () => {
    const full = new Int16Array([111, 222, 333, 444])
    const view = full.subarray(1, 3)
    const bytes = decode(pcm16ToBase64(view))
    expect(bytes).toEqual([...new Uint8Array(view.buffer, view.byteOffset, view.byteLength)])
    expect(bytes.length).toBe(4)
  })

  it('does not throw on loud samples that break fromCharCode(btoa)', () => {
    // 1200 / -1200 就是旧实现的必炸值（码点 > 255）。
    const loud = new Int16Array(2048).fill(1200)
    expect(() => pcm16ToBase64(loud)).not.toThrow()
    expect(decode(pcm16ToBase64(loud)).slice(0, 2)).toEqual([0xb0, 0x04])
  })
})
