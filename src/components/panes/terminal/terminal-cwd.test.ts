import { describe, expect, it } from 'vitest'

import { pickTerminalCwd } from './terminal-cwd'

describe('pickTerminalCwd', () => {
  it('returns the active session workspace', () => {
    const cwd = pickTerminalCwd({
      activeId: 'a',
      entries: { a: { cwd: 'C:\\work\\repo' }, b: { cwd: 'C:\\work\\other' } },
    })
    expect(cwd).toBe('C:\\work\\repo')
  })

  it('returns undefined when there is no active session', () => {
    expect(pickTerminalCwd({ activeId: null, entries: {} })).toBeUndefined()
  })

  it('returns undefined when the active session has no workspace', () => {
    expect(pickTerminalCwd({ activeId: 'a', entries: { a: {} } })).toBeUndefined()
    expect(pickTerminalCwd({ activeId: 'a', entries: { a: { cwd: '   ' } } })).toBeUndefined()
    expect(pickTerminalCwd({ activeId: 'a', entries: {} })).toBeUndefined()
  })

  it('trims the workspace path it forwards to the host', () => {
    expect(pickTerminalCwd({ activeId: 'a', entries: { a: { cwd: '  C:\\w\\r  ' } } })).toBe(
      'C:\\w\\r',
    )
  })
})
