import { describe, expect, it } from 'vitest'

import {
  isTerminalPanelId,
  nextTerminalPanelId,
  nextTerminalPanelTitle,
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

describe('nextTerminalPanelTitle（ZCode createTerminalSidePaneTitle 同源）', () => {
  it('uses the base title when it is free', () => {
    expect(nextTerminalPanelTitle('mirach-harness', new Set())).toBe('mirach-harness')
  })

  it('appends the first free index from 2', () => {
    expect(nextTerminalPanelTitle('mirach-harness', new Set(['mirach-harness']))).toBe(
      'mirach-harness 2',
    )
    expect(
      nextTerminalPanelTitle('mirach-harness', new Set(['mirach-harness', 'mirach-harness 2'])),
    ).toBe('mirach-harness 3')
  })

  it('reuses a hole left by a closed tab (关掉 2 号后新建仍得 2)', () => {
    expect(
      nextTerminalPanelTitle('mirach-harness', new Set(['mirach-harness', 'mirach-harness 3'])),
    ).toBe('mirach-harness 2')
  })

  it('falls back to the base after all numbered titles close', () => {
    expect(nextTerminalPanelTitle('mirach-harness', new Set(['mirach-harness 2']))).toBe(
      'mirach-harness',
    )
  })
})

describe('nextTerminalPanelId', () => {
  it('returns the smallest free id starting at terminal', () => {
    expect(nextTerminalPanelId([])).toBe('terminal')
    expect(nextTerminalPanelId(['terminal'])).toBe('terminal-2')
    expect(nextTerminalPanelId(['terminal', 'terminal-2'])).toBe('terminal-3')
  })

  it('reuses a hole left by a closed panel', () => {
    expect(nextTerminalPanelId(['terminal', 'terminal-3'])).toBe('terminal-2')
  })
})

describe('isTerminalPanelId', () => {
  it('accepts terminal and numbered terminal panels only', () => {
    expect(isTerminalPanelId('terminal')).toBe(true)
    expect(isTerminalPanelId('terminal-2')).toBe(true)
    expect(isTerminalPanelId('terminal-17')).toBe(true)
  })

  it('rejects lookalikes', () => {
    expect(isTerminalPanelId('terminal-')).toBe(false)
    expect(isTerminalPanelId('terminal-2x')).toBe(false)
    expect(isTerminalPanelId('terminal-x')).toBe(false)
    expect(isTerminalPanelId('terminalabc')).toBe(false)
    expect(isTerminalPanelId('files')).toBe(false)
  })
})
