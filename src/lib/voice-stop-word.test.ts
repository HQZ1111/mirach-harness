/**
 * 口语停止词判定单测（hermes voice-stop-word 同域）：整句判、包含 stop 的
 * 实质请求不吞、中文等价词（宿主适配）。
 */
import { describe, expect, it } from 'vitest'

import { isVoiceStopCommand } from './voice-stop-word'

describe('isVoiceStopCommand（hermes 同语义）', () => {
  it('英文停止语整句命中', () => {
    expect(isVoiceStopCommand('stop')).toBe(true)
    expect(isVoiceStopCommand('Stop it.')).toBe(true)
    expect(isVoiceStopCommand('please stop')).toBe(true)
    expect(isVoiceStopCommand("that's all")).toBe(true)
    expect(isVoiceStopCommand('never mind')).toBe(true)
  })

  it('称呼前缀剥离后命中', () => {
    expect(isVoiceStopCommand('hey Mirach, stop')).toBe(true)
    expect(isVoiceStopCommand('ok stop')).toBe(true)
    expect(isVoiceStopCommand('hermes stop')).toBe(true)
  })

  it('包含 stop 的实质请求不命中（保守判定的核心）', () => {
    expect(isVoiceStopCommand('stop the docker container')).toBe(false)
    expect(isVoiceStopCommand('how do I stop a running process')).toBe(false)
  })

  it('中文停止语命中（宿主适配）', () => {
    expect(isVoiceStopCommand('停止')).toBe(true)
    expect(isVoiceStopCommand('停止。')).toBe(true)
    expect(isVoiceStopCommand('请停止')).toBe(true)
    expect(isVoiceStopCommand('再见')).toBe(true)
    expect(isVoiceStopCommand('结束对话')).toBe(true)
  })

  it('中文实质请求不命中', () => {
    expect(isVoiceStopCommand('停止那个容器')).toBe(false)
    expect(isVoiceStopCommand('怎么停止进程')).toBe(false)
  })

  it('空/裸称呼不命中', () => {
    expect(isVoiceStopCommand('')).toBe(false)
    expect(isVoiceStopCommand('mirach')).toBe(false)
    expect(isVoiceStopCommand('好的')).toBe(false)
  })

  it('disabled 配置关闭判定', () => {
    expect(isVoiceStopCommand('stop', { mode: 'disabled' })).toBe(false)
  })
})
