/**
 * branch-store 单测：纯逻辑——IPC 返回的严格解析（parseSiblingBranches /
 * parseForkPoints）、模板 props 映射（toBranchPickerView）与 store 请求
 * 信令（requestFork/requestSwitch/clear 的 seq 语义、requestRefresh 递增、
 * composer 预填写入）。IPC 不在测试面（refresh 的拉取路径由真实环境验证）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  branchBridge,
  parseForkPoints,
  parseSiblingBranches,
  toBranchPickerView,
} from './branch-store'

/** 静音解析失败的 console.error（被测行为就是报错——断言调用而非听噪声） */
const silenceErrors = () => vi.spyOn(console, 'error').mockImplementation(() => {})

const validBranches = {
  forkPointId: 'fp-1',
  branches: [
    { rootId: 'r1', leafId: 'leaf-a', preview: '第一条分支预览', messageCount: 3, isCurrent: false },
    { rootId: 'r1', leafId: 'leaf-b', preview: '第二条分支预览', messageCount: 5, isCurrent: true },
  ],
}

describe('parseSiblingBranches', () => {
  it('合法形状原样解析（isCurrent 严格布尔）', () => {
    const spy = silenceErrors()
    const out = parseSiblingBranches(validBranches)
    expect(out).not.toBeNull()
    expect(out!.forkPointId).toBe('fp-1')
    expect(out!.branches).toHaveLength(2)
    expect(out!.branches[1]).toEqual({
      rootId: 'r1',
      leafId: 'leaf-b',
      preview: '第二条分支预览',
      messageCount: 5,
      isCurrent: true,
    })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('null 合法（无分支/无活动会话）', () => {
    expect(parseSiblingBranches(null)).toBeNull()
  })

  it('整体形状非法 → null 且 console.error 可见', () => {
    const spy = silenceErrors()
    expect(parseSiblingBranches('nope')).toBeNull()
    expect(parseSiblingBranches({ branches: 'not-array' })).toBeNull()
    expect(parseSiblingBranches([validBranches])).toBeNull()
    expect(spy).toHaveBeenCalledTimes(3)
    spy.mockRestore()
  })

  it('单行字段缺失 → 跳过该行保留其余（选择走 leafId 自洽映射）', () => {
    const spy = silenceErrors()
    const out = parseSiblingBranches({
      forkPointId: null,
      branches: [
        { rootId: 'r1', leafId: 'leaf-a', preview: 'x', messageCount: 1, isCurrent: true },
        { rootId: 'r1', leafId: 42, preview: 'x', messageCount: 1, isCurrent: false },
        { rootId: 'r1', leafId: 'leaf-c', preview: 'x', messageCount: Number.NaN, isCurrent: false },
      ],
    })
    expect(out).not.toBeNull()
    expect(out!.branches).toHaveLength(1)
    expect(out!.branches[0]!.leafId).toBe('leaf-a')
    expect(spy).toHaveBeenCalledTimes(2)
    spy.mockRestore()
  })

  it('forkPointId 类型非法 → 按 null 处理但报错可见', () => {
    const spy = silenceErrors()
    const out = parseSiblingBranches({
      forkPointId: 7,
      branches: [{ rootId: 'r1', leafId: 'leaf-a', preview: 'x', messageCount: 1, isCurrent: true }],
    })
    expect(out).not.toBeNull()
    expect(out!.forkPointId).toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})

describe('parseForkPoints', () => {
  it('合法清单原样解析', () => {
    const spy = silenceErrors()
    const out = parseForkPoints([
      { entryId: 'e1', text: '第一条' },
      { entryId: 'e2', text: '第二条' },
    ])
    expect(out).toEqual([
      { entryId: 'e1', text: '第一条' },
      { entryId: 'e2', text: '第二条' },
    ])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('非数组 → []', () => {
    const spy = silenceErrors()
    expect(parseForkPoints({ entryId: 'e1' })).toEqual([])
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('任一行非法 → 整份丢弃（index 映射键不容错位）', () => {
    const spy = silenceErrors()
    const out = parseForkPoints([
      { entryId: 'e1', text: '第一条' },
      { entryId: 'e2' },
      { entryId: 'e3', text: '第三条' },
    ])
    expect(out).toEqual([])
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})

describe('toBranchPickerView', () => {
  it('variants 吃 preview、index 吃 isCurrent 项', () => {
    const view = toBranchPickerView(parseSiblingBranches(validBranches)!)
    expect(view.variants).toEqual(['第一条分支预览', '第二条分支预览'])
    expect(view.index).toBe(1)
  })

  it('无 isCurrent 项落 0（prev/next 仍可用）', () => {
    const view = toBranchPickerView({
      forkPointId: null,
      branches: [
        { rootId: 'r1', leafId: 'a', preview: 'p1', messageCount: 1, isCurrent: false },
      ],
    })
    expect(view.index).toBe(0)
    expect(view.variants).toEqual(['p1'])
  })
})

describe('branchBridge 请求信令', () => {
  beforeEach(() => {
    // 单例 store：清场上轮残留，保证用例互不依赖
    branchBridge.setState({
      branches: null,
      forkPoints: [],
      forkRequest: null,
      switchRequest: null,
      composerPrefill: null,
    })
  })

  it('requestRefresh 递增 refreshSeq', () => {
    const before = branchBridge.getState().refreshSeq
    branchBridge.getState().requestRefresh()
    expect(branchBridge.getState().refreshSeq).toBe(before + 1)
  })

  it('requestFork 带单调 seq 与映射入参；clear 仅清自身 seq', () => {
    branchBridge.getState().requestFork(2, '第一条')
    const req = branchBridge.getState().forkRequest
    expect(req).not.toBeNull()
    expect(req!.userOrdinal).toBe(2)
    expect(req!.expectText).toBe('第一条')
    // 错 seq 不清（执行器 finally 只清自己发起的那笔）
    branchBridge.getState().clearForkRequest(req!.seq + 100)
    expect(branchBridge.getState().forkRequest).toBe(req)
    branchBridge.getState().clearForkRequest(req!.seq)
    expect(branchBridge.getState().forkRequest).toBeNull()
  })

  it('fork seq 单调递增（clear 后不复位）', () => {
    branchBridge.getState().requestFork(0, 'a')
    const seq1 = branchBridge.getState().forkRequest!.seq
    branchBridge.getState().clearForkRequest(seq1)
    branchBridge.getState().requestFork(1, 'b')
    const seq2 = branchBridge.getState().forkRequest!.seq
    expect(seq2).toBeGreaterThan(seq1)
    branchBridge.getState().clearForkRequest(seq2)
  })

  it('requestSwitch/clearSwitchRequest 同款 seq 语义', () => {
    branchBridge.getState().requestSwitch('leaf-b')
    const req = branchBridge.getState().switchRequest
    expect(req).not.toBeNull()
    expect(req!.leafId).toBe('leaf-b')
    branchBridge.getState().clearSwitchRequest(req!.seq + 1)
    expect(branchBridge.getState().switchRequest).toBe(req)
    branchBridge.getState().clearSwitchRequest(req!.seq)
    expect(branchBridge.getState().switchRequest).toBeNull()
  })

  it('setComposerPrefill 写入 {seq, text} 且 seq 单调', () => {
    branchBridge.getState().setComposerPrefill('预填文本')
    const p1 = branchBridge.getState().composerPrefill
    expect(p1!.text).toBe('预填文本')
    branchBridge.getState().setComposerPrefill('再填一次')
    const p2 = branchBridge.getState().composerPrefill
    expect(p2!.text).toBe('再填一次')
    expect(p2!.seq).toBeGreaterThan(p1!.seq)
  })
})
