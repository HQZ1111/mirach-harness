/**
 * 模型选择器的 provider 分组（2026-10-26 用户："输入框里的模型怎么没有按
 * 名称分组显示，像 zcode 和 hermes 一样"）。
 *
 * 上游 assistant-ui 的 ModelSelector 是扁平列表；ZCode 的 `ModelConfigSelect`
 * 收 `modelGroups: ModelSelectGroup[]`（每 group 一个 provider，带 label +
 * items），hermes 同样按 provider 分节。这里锁住三件事：
 *
 * 1. `toModelOptions` 把 provider 写进 `group`（分组键的唯一来源）；
 * 2. 分组**保持首次出现顺序**（pi_list_models 是稳定目录序，打乱会让用户
 *    每次打开看到不同顺序）；
 * 3. `group` 缺失时退化到 `description`（宿主把它填成 provider 名），
 *    再不行落 '其他' —— 老调用点不改也自动分组。
 */
import { describe, expect, it } from 'vitest'

import { toModelOptions, type PiModelEntry } from '@/components/assistant-ui/model-catalog-store'

const entry = (provider: string, id: string, reasoning = false): PiModelEntry => ({
  provider,
  id,
  name: id,
  reasoning,
  contextWindow: 200000,
})

describe('toModelOptions 分组', () => {
  it('把 provider 写进 group（分组键的唯一来源）', () => {
    const options = toModelOptions([entry('deepseek', 'deepseek-chat')])
    expect(options[0]?.group).toBe('deepseek')
    expect(options[0]?.description).toBe('deepseek')
    expect(options[0]?.id).toBe('deepseek/deepseek-chat')
  })

  it('同 provider 的多个模型共享同一个 group', () => {
    const options = toModelOptions([
      entry('deepseek', 'deepseek-chat'),
      entry('deepseek', 'deepseek-reasoner', true),
      entry('amazon-bedrock', 'nova-lite'),
    ])
    expect(options.map((o) => o.group)).toEqual([
      'deepseek',
      'deepseek',
      'amazon-bedrock',
    ])
  })

  it('reasoning 模型带 efforts，非 reasoning 不带', () => {
    const options = toModelOptions([
      entry('deepseek', 'deepseek-reasoner', true),
      entry('deepseek', 'deepseek-chat', false),
    ])
    expect(options[0]?.efforts).toBe(true)
    expect(options[1]?.efforts).toBeUndefined()
  })
})

describe('分组键的退化链', () => {
  /** 与 ModelSelectorList 里的聚合逻辑同构（纯函数版本，供单测）。 */
  const groupModels = (
    models: readonly { id: string; group?: string; description?: string }[],
  ) => {
    const byKey = new Map<string, string[]>()
    for (const model of models) {
      const key = model.group ?? model.description ?? '其他'
      const bucket = byKey.get(key)
      if (bucket === undefined) byKey.set(key, [model.id])
      else bucket.push(model.id)
    }
    return [...byKey.entries()]
  }

  it('有 group 时用 group', () => {
    expect(
      groupModels([{ id: 'a', group: 'deepseek', description: '别的' }]),
    ).toEqual([['deepseek', ['a']]])
  })

  it('没有 group 时退化到 description', () => {
    expect(groupModels([{ id: 'a', description: 'anthropic' }])).toEqual([
      ['anthropic', ['a']],
    ])
  })

  it('两者都没有时落「其他」', () => {
    expect(groupModels([{ id: 'a' }])).toEqual([['其他', ['a']]])
  })

  it('保持首次出现顺序（不打乱目录序）', () => {
    const groups = groupModels([
      { id: '1', group: 'b' },
      { id: '2', group: 'a' },
      { id: '3', group: 'b' },
    ])
    expect(groups.map(([key]) => key)).toEqual(['b', 'a'])
    expect(groups[0]?.[1]).toEqual(['1', '3'])
  })
})

describe('折叠：默认展开哪一组', () => {
  /**
   * 与 ModelSelectorList 的 `selectedGroupKey` 同构：选中模型所在组。
   * 没有选中值时退回第一组（总得有一组可见，否则面板一片空白）。
   */
  const selectedGroupOf = (
    groups: readonly { key: string; ids: readonly string[] }[],
    value: string | undefined,
  ) => {
    if (value === undefined) return groups[0]?.key
    return groups.find((g) => g.ids.includes(value))?.key
  }

  const groups = [
    { key: 'amazon-bedrock', ids: ['amazon-bedrock/a', 'amazon-bedrock/b'] },
    { key: 'deepseek', ids: ['deepseek/deepseek-chat'] },
  ]

  it('选中 deepseek 时展开 deepseek 组（不是第一组）', () => {
    expect(selectedGroupOf(groups, 'deepseek/deepseek-chat')).toBe('deepseek')
  })

  it('没有选中值时退回第一组（否则面板全空）', () => {
    expect(selectedGroupOf(groups, undefined)).toBe('amazon-bedrock')
  })

  it('选中值不在任何组里时返回 undefined（调用方不展开任何组）', () => {
    expect(selectedGroupOf(groups, 'gone/model')).toBeUndefined()
  })
})
