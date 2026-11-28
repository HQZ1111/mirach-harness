/**
 * ask_user 结果的解析（ZCode AskUserQuestion 卡的数据面）：
 * `details.answers` 每项 {id, question, values, text, confirmed}——
 * values = 选项标题数组，text = 自由输入；两者都没有 = 空答案（不编造）。
 */
import { describe, expect, it } from 'vitest'

import { parseAskAnswers } from './tool-renderers.aui'

describe('parseAskAnswers', () => {
  it('选项答案取 values，自由输入取 text', () => {
    expect(
      parseAskAnswers({
        details: {
          answers: [
            { id: 'q1', question: '今晚吃什么？', values: ['面', '饭'], text: null },
            { id: 'q2', question: '备注？', values: [], text: '少辣' },
          ],
        },
      }),
    ).toEqual([
      { question: '今晚吃什么？', answer: '面、饭' },
      { question: '备注？', answer: '少辣' },
    ])
  })

  it('空 values + 空 text = answer null（不编造答案）', () => {
    expect(
      parseAskAnswers({ details: { answers: [{ question: 'Q', values: [], text: '' }] } }),
    ).toEqual([{ question: 'Q', answer: null }])
  })

  it('无 details.answers（失败/旧结果）= 空数组', () => {
    expect(parseAskAnswers(null)).toEqual([])
    expect(parseAskAnswers({})).toEqual([])
    expect(parseAskAnswers({ details: {} })).toEqual([])
    expect(parseAskAnswers({ details: { answers: 'nope' } })).toEqual([])
  })
})

// ── todo 工具结果 → TodoList 卡片（对话区任务清单）─────────────────────
// 2026-11-27 用户：「任务清单，对话中并没有显示」。此前 todo 结果只在侧栏
// 活动面板消费，消息流里被 showTodos=false 整条跳过。
import { todoItemsFromResult } from './tool-renderers.aui'

describe('todoItemsFromResult', () => {
  it('把 todo_list.v1 的 phases[].tasks 平铺成 TodoItem', () => {
    const items = todoItemsFromResult({
      content: [],
      details: {
        schema: 'todo_list.v1',
        list: {
          phases: [
            {
              name: '阶段一',
              tasks: [
                { content: '读源码', state: 'done' },
                { content: '写补丁', state: 'in_progress' },
              ],
            },
          ],
        },
      },
    })
    expect(items).not.toBeNull()
    expect(items!.map((i) => [i.text, i.status])).toEqual([
      ['读源码', 'done'],
      ['写补丁', 'active'],
    ])
    // id 必须是字符串（TodoList 只当 React key 用）
    expect(items!.every((i) => typeof i.id === 'string')).toBe(true)
  })

  it('blocked 任务映射成 failed 且带原因', () => {
    const items = todoItemsFromResult({
      content: [],
      details: {
        schema: 'todo_list.v1',
        list: {
          phases: [{ tasks: [{ content: '部署', state: 'blocked', reason: '无凭据' }] }],
        },
      },
    })
    expect(items).toEqual([
      { id: '0', text: '部署', status: 'failed', reason: '无凭据' },
    ])
  })

  it('多 phase 按顺序平铺', () => {
    const items = todoItemsFromResult({
      content: [],
      details: {
        schema: 'todo_list.v1',
        list: {
          phases: [
            { tasks: [{ content: 'a', state: 'done' }] },
            { tasks: [{ content: 'b', state: 'open' }] },
          ],
        },
      },
    })
    expect(items!.map((i) => i.text)).toEqual(['a', 'b'])
  })

  it('非 todo 结果 / 空任务 / 错 schema 都返回 null（不假装有清单）', () => {
    expect(todoItemsFromResult({ content: [] })).toBeNull()
    expect(todoItemsFromResult('plain text')).toBeNull()
    expect(
      todoItemsFromResult({
        content: [],
        details: { schema: 'something-else', list: { phases: [] } },
      }),
    ).toBeNull()
    expect(
      todoItemsFromResult({
        content: [],
        details: { schema: 'todo_list.v1', list: { phases: [{ tasks: [] }] } },
      }),
    ).toBeNull()
  })
})
