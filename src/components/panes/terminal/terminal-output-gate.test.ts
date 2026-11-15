import { describe, expect, it } from 'vitest'

import { TerminalOutputGate } from './terminal-output-gate'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('TerminalOutputGate', () => {
  it('queues events until attach, then replays backlog before them', () => {
    const gate = new TerminalOutputGate()
    // attach 前到达的事件块：不写屏幕（顺序未定）
    expect(gate.push(bytes('live-1'))).toBe('')
    expect(gate.push(bytes('live-2'))).toBe('')

    // attach 回包 = 宿主 backlog；排队块必须排在其后
    const text = gate.attachBacklog(bytes('backlog'))
    expect(text).toBe('backloglive-1live-2')
  })

  it('passes events straight through after attach', () => {
    const gate = new TerminalOutputGate()
    gate.attachBacklog(new Uint8Array(0))
    expect(gate.push(bytes('hello'))).toBe('hello')
    expect(gate.push(bytes(' world'))).toBe(' world')
  })

  it('reassembles UTF-8 split across IPC chunks (中文不乱码)', () => {
    const gate = new TerminalOutputGate()
    const full = bytes('中文输出')
    // 3 字节的"中"劈成 2 + 1
    const first = full.slice(0, 2)
    const rest = full.slice(2)

    // attach 路径：backlog 自身跨块
    expect(gate.attachBacklog(first) + gate.push(rest)).toBe('中文输出')
  })

  it('keeps order and character continuity among queued chunks', () => {
    const gate = new TerminalOutputGate()
    const full = bytes('你好')
    expect(gate.push(full.slice(0, 1))).toBe('')
    expect(gate.push(full.slice(1, 4))).toBe('')
    expect(gate.push(full.slice(4))).toBe('')
    expect(gate.attachBacklog(new Uint8Array(0))).toBe('你好')
  })

  it('flushes a dangling partial sequence on finish', () => {
    const gate = new TerminalOutputGate()
    gate.attachBacklog(new Uint8Array(0))
    // 单独一个 UTF-8 首字节 = 不完整序列
    expect(gate.push(Uint8Array.from([0xe4]))).toBe('')
    const tail = gate.finish()
    expect(tail.length).toBeGreaterThan(0)
  })

  it('finish drains queued chunks that never reached attach', () => {
    const gate = new TerminalOutputGate()
    expect(gate.push(bytes('pending'))).toBe('')
    expect(gate.finish()).toBe('pending')
  })
})
