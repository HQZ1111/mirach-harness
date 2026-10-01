import { describe, expect, it } from 'vitest'

import { normalizePowerShellReadlineRedraw } from './terminal-data-transform'
import { base64ToBytes, formatShellLabel } from './terminal-format'

const ESC = String.fromCharCode(0x1b)

describe('formatShellLabel', () => {
  it('maps powershell executables to PowerShell label', () => {
    expect(formatShellLabel('powershell.exe')).toBe('PowerShell')
    expect(formatShellLabel('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(
      'PowerShell',
    )
    expect(formatShellLabel('/usr/bin/pwsh')).toBe('PowerShell')
  })

  it('normalizes other shells to bare lowercase name without .exe', () => {
    expect(formatShellLabel('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('bash')
    expect(formatShellLabel('/bin/zsh')).toBe('zsh')
  })

  it('returns the raw string when it has no path segments', () => {
    expect(formatShellLabel('fish')).toBe('fish')
  })

  it('returns null for missing shell', () => {
    expect(formatShellLabel(null)).toBeNull()
  })
})

describe('base64ToBytes', () => {
  it('decodes base64 payload back to the original bytes', () => {
    const bytes = base64ToBytes(btoa('hello'))
    expect(Array.from(bytes)).toEqual([104, 101, 108, 108, 111])
  })

  it('decodes binary (non-utf8) bytes losslessly', () => {
    const original = Uint8Array.from([0x00, 0x1b, 0xff, 0xfe, 0x80])
    const decoded = base64ToBytes(
      btoa(String.fromCharCode(...original)),
    )
    expect(Array.from(decoded)).toEqual(Array.from(original))
  })
})

describe('normalizePowerShellReadlineRedraw', () => {
  it('passes through data for non-PowerShell shells', () => {
    const data = `${ESC}[2;5H${ESC}[37mtext${ESC}[40m`
    expect(normalizePowerShellReadlineRedraw(data, 'bash.exe')).toBe(data)
    expect(normalizePowerShellReadlineRedraw(data, null)).toBe(data)
  })

  it('rewrites 40m to 49m only in PSReadLine-style line redraws', () => {
    const redraw = `${ESC}[5;3H${ESC}[37mC:\\>${ESC}[40m`
    const normalized = normalizePowerShellReadlineRedraw(redraw, 'powershell.exe')
    expect(normalized).toBe(`${ESC}[5;3H${ESC}[37mC:\\>${ESC}[49m`)
  })

  it('leaves PowerShell data without cursor-move redraw untouched', () => {
    const data = `${ESC}[37mplain${ESC}[40m`
    expect(normalizePowerShellReadlineRedraw(data, 'powershell.exe')).toBe(data)
  })

  it('leaves multi-chunk data containing newline untouched', () => {
    const data = `${ESC}[2;5Hline\n${ESC}[40m`
    expect(normalizePowerShellReadlineRedraw(data, 'pwsh')).toBe(data)
  })
})
