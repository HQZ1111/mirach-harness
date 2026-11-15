import { describe, expect, it } from 'vitest'

import {
  formatTerminalTabTitle,
  nextTerminalIndex,
  terminalProjectName,
} from './terminal-tabs'

describe('terminalProjectName', () => {
  it('takes the leaf of a windows or posix path', () => {
    expect(terminalProjectName('C:\\work\\mirach-harness')).toBe('mirach-harness')
    expect(terminalProjectName('/home/me/project')).toBe('project')
  })

  it('ignores trailing separators', () => {
    expect(terminalProjectName('C:\\work\\repo\\')).toBe('repo')
    expect(terminalProjectName('/home/me/project/')).toBe('project')
  })

  it('returns null when there is no usable leaf', () => {
    expect(terminalProjectName(null)).toBeNull()
    expect(terminalProjectName(undefined)).toBeNull()
    expect(terminalProjectName('')).toBeNull()
    expect(terminalProjectName('   ')).toBeNull()
    expect(terminalProjectName('/')).toBeNull()
  })
})

describe('formatTerminalTabTitle', () => {
  it('leaves the first tab untitled with an index', () => {
    expect(formatTerminalTabTitle('mirach-harness', 1)).toBe('mirach-harness')
  })

  it('appends the index for later tabs (ZCode 同款)', () => {
    expect(formatTerminalTabTitle('mirach-harness', 2)).toBe('mirach-harness 2')
    expect(formatTerminalTabTitle('mirach-harness', 7)).toBe('mirach-harness 7')
  })

  it('defends against non-positive indices', () => {
    expect(formatTerminalTabTitle('mirach-harness', 0)).toBe('mirach-harness')
  })
})

describe('nextTerminalIndex', () => {
  it('returns the smallest free index starting at 1', () => {
    expect(nextTerminalIndex([])).toBe(1)
    expect(nextTerminalIndex([1])).toBe(2)
    expect(nextTerminalIndex([1, 2, 3])).toBe(4)
  })

  it('reuses a hole left by a closed tab (不是只增不减的计数器)', () => {
    expect(nextTerminalIndex([1, 3])).toBe(2)
    expect(nextTerminalIndex([2, 3])).toBe(1)
  })
})
