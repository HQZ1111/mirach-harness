/**
 * 谱系条父会话名反查单测（任务 3）：resolveLineageParentName 纯函数——
 * path 匹配（normalizeDisplayPath 规整 \\ 与 /）、无匹配 → null（组件层
 * 回退文件名尾段）、name 为空（pi 未命名会话）→ null。IPC
 * （lookupLineageParentName）不在测试面。
 */
import { describe, expect, it } from 'vitest'

import { resolveLineageParentName } from './session-lineage-name'

describe('resolveLineageParentName（谱系条父会话名反查）', () => {
  it('path 精确匹配 → 父会话 name', () => {
    const sessions = [{ path: 'G:\\mirach\\.pi\\sessions\\abc.jsonl', name: '历史会话A' }]
    expect(resolveLineageParentName('G:\\mirach\\.pi\\sessions\\abc.jsonl', sessions)).toBe(
      '历史会话A',
    )
  })

  it('\\ 与 / 分隔符同义（normalizeDisplayPath 规整后相等）', () => {
    const sessions = [{ path: 'G:/mirach/.pi/sessions/abc.jsonl', name: '正斜杠存档' }]
    expect(resolveLineageParentName('G:\\mirach\\.pi\\sessions\\abc.jsonl', sessions)).toBe(
      '正斜杠存档',
    )
  })

  it('无匹配条目 → null（组件层回退文件名尾段）', () => {
    const sessions = [{ path: 'G:\\other\\def.jsonl', name: '别的会话' }]
    expect(resolveLineageParentName('G:\\mirach\\abc.jsonl', sessions)).toBeNull()
  })

  it('匹配条目 name 为空（pi 未命名会话）→ null', () => {
    const sessions = [{ path: 'G:\\mirach\\abc.jsonl', name: null }]
    expect(resolveLineageParentName('G:\\mirach\\abc.jsonl', sessions)).toBeNull()
  })

  it('空表 → null', () => {
    expect(resolveLineageParentName('G:\\mirach\\abc.jsonl', [])).toBeNull()
  })
})
