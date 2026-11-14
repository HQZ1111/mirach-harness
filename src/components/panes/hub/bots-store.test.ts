/**
 * bots-store 纯函数单测（2026-11-08）：botChatPaths 的双锚信任规则。
 *
 * 背景：pi 无 hidden 会话面、sessions 表只有 path 主键（name 无唯一索引）
 * ——bot 永久会话的「会话侧栏隐藏」只能做在前端显示层，过滤数据源 =
 * botChatPaths。信任规则：path + sessionId 双锚才参与（旧名字匹配记录
 * 可能指向同名用户会话，重新锚定前不得隐藏任何行）。
 */
import { describe, expect, it } from 'vitest'

import { botChatPaths, type BotPreset } from './bots-store'

const bot = (over: Partial<BotPreset>): BotPreset => ({
  name: 'a',
  title: '',
  systemPrompt: '',
  model: '',
  cwd: '',
  description: '',
  createdAt: 0,
  ...over,
})

describe('botChatPaths 双锚信任规则', () => {
  it('path + sessionId 双锚记录参与过滤', () => {
    const set = botChatPaths([bot({ chatSessionPath: 'C:/s/a.jsonl', chatSessionId: 'id-a' })])
    expect(set.has('C:/s/a.jsonl')).toBe(true)
    expect(set.size).toBe(1)
  })

  it('只有 path 没有锚（旧名字匹配记录）不参与——防误藏同名用户会话', () => {
    const set = botChatPaths([bot({ chatSessionPath: 'C:/s/maybe-user.jsonl' })])
    expect(set.size).toBe(0)
  })

  it('只有锚没有路径（索引查找失败的记录）不参与', () => {
    const set = botChatPaths([bot({ chatSessionId: 'id-a' })])
    expect(set.size).toBe(0)
  })

  it('null / 缺省字段不参与；多 bot 聚合去重', () => {
    const set = botChatPaths([
      bot({ name: 'a', chatSessionPath: null, chatSessionId: null }),
      bot({ name: 'b' }),
      bot({ name: 'c', chatSessionPath: 'C:/s/x.jsonl', chatSessionId: 'id-x' }),
      bot({ name: 'd', chatSessionPath: 'C:/s/x.jsonl', chatSessionId: 'id-x2' }),
    ])
    expect(set.size).toBe(1)
    expect(set.has('C:/s/x.jsonl')).toBe(true)
  })

  it('空花名册 = 空集（侧栏不过滤任何行）', () => {
    expect(botChatPaths([]).size).toBe(0)
  })
})
