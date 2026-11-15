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
