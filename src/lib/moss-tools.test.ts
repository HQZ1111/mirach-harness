/**
 * MOSS 语音工具面单测：声明集合法性（协议规则自查，防漂移）+ 输出整形
 * （输入 = 各 IPC 命令的真实返回形状）。执行器分发不在此测（node 无 Tauri
 * IPC）——协议态机见 moss-tool-flow.test.ts，实机链路走 CDP 冒烟。
 */
import { describe, expect, it } from 'vitest'

import {
  MOSS_VOICE_TOOLS,
  shapeAppStateOutput,
  shapeCronJobsOutput,
  shapeCronTriggerOutput,
  shapeNowOutput,
  shapeSessionsOutput,
  shapeTodoOutput,
  shapeUsageOutput,
  validateToolDecls,
} from './moss-tools'

describe('MOSS_VOICE_TOOLS（协议声明规则自查）', () => {
  it('整套声明零校验错误（vendor 整表拒绝 = 声明漂移）', () => {
    expect(validateToolDecls(MOSS_VOICE_TOOLS)).toEqual([])
  })

  it('工具面口径：只读集 + run_cron_job_now（async_effect）', () => {
    const names = MOSS_VOICE_TOOLS.map((t) => t.name)
    expect(names).toEqual([
      'get_now',
      'get_session_usage',
      'list_sessions',
      'get_app_state',
      'get_todo_state',
      'list_cron_jobs',
      'run_cron_job_now',
    ])
    const trigger = MOSS_VOICE_TOOLS.find((t) => t.name === 'run_cron_job_now')
    expect(trigger?.execution_mode).toBe('async_effect')
    expect(trigger?.read_only).toBe(false)
    // 只读集全部 sync + read_only（语音场景不做写类工具——审批面不可见）
    for (const t of MOSS_VOICE_TOOLS) {
      if (t.name === 'run_cron_job_now') continue
      expect(t.execution_mode).toBe('sync')
      expect(t.read_only).toBe(true)
    }
  })

  it('校验器抓四类违例：name 形状 / 重复 / 空 description / async 配对', () => {
    const base = { type: 'function' as const, name: 'ok_tool', description: '描述' }
    expect(
      validateToolDecls([
        { ...base, name: '1bad' },
        { ...base, name: 'a'.repeat(65) },
        { ...base, description: '   ' },
        { ...base, name: 'dup' },
        { ...base, name: 'dup' },
        { ...base, name: 'q', execution_mode: 'async_query' },
        { ...base, name: 'e', execution_mode: 'async_effect', read_only: true },
      ]),
    ).toHaveLength(6)
  })
})

describe('shapeNowOutput', () => {
  it('本地字段直出（不依赖 Intl 环境）', () => {
    const d = new Date(2026, 10, 13, 9, 5, 3) // 2026-11-13 09:05:03 周五
    const out = shapeNowOutput(d)
    expect(out).toContain('2026-11-13 09:05:03')
    expect(out).toContain('周五')
    expect(out).toContain('UTC')
  })
})

describe('shapeUsageOutput（pi_usage_snapshot 真形状）', () => {
  const snapshot = {
    range: '7d',
    generatedAt: 1,
    source: 'local',
    summary: {
      totalTokens: 12345,
      inputTokens: 10000,
      outputTokens: 2345,
      cacheHitRate: 0.5,
      totalSessions: 3,
      totalTurns: 45,
      toolCallCount: 12,
      activeDays: 5,
      currentStreakDays: 2,
      longestStreakDays: 3,
      peakDayTokens: 4000,
      favoriteModel: 'deepseek-chat',
    },
  }

  it('关键数字进行文', () => {
    const out = shapeUsageOutput(snapshot)
    expect(out).toContain('7d')
    expect(out).toContain('12,345')
    expect(out).toContain('轮次 45')
    expect(out).toContain('会话 3')
    expect(out).toContain('deepseek-chat')
  })

  it('缺 summary = 抛错（如实传播，不造 0）', () => {
    expect(() => shapeUsageOutput({ range: '7d' })).toThrow('summary')
  })
})

describe('shapeSessionsOutput（pi_list_sessions 真形状）', () => {
  const row = (i: number, mod: number): Record<string, unknown> => ({
    path: `/s/${i}.jsonl`,
    id: `id-${i}`,
    cwd: 'G:/x',
    timestamp: '',
    messageCount: i,
    lastModifiedMs: mod,
    sizeBytes: 100,
    name: `会话${i}`,
  })

  it('按最近修改排序 + 行文带名称/时间/消息数', () => {
    const out = shapeSessionsOutput([row(1, 1000), row(2, 3000), row(3, 2000)])
    const lines = out.split('\n')
    expect(out).toContain('共 3 条会话')
    expect(lines[1]).toContain('会话2')
    expect(lines[2]).toContain('会话3')
    expect(lines[3]).toContain('会话1')
  })

  it('空列表 = 诚实空态', () => {
    expect(shapeSessionsOutput([])).toBe('还没有任何聊天会话。')
  })

  it('超 15 条只显最近 15（注明总数）', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(i, i))
    const out = shapeSessionsOutput(rows)
    expect(out).toContain('共 20 条会话，最近 15 条')
    expect(out).toContain('会话19')
    expect(out).not.toContain('会话0（')
  })
})

describe('shapeAppStateOutput（pi_get_state 真形状）', () => {
  it('模型/提供方/思考档位/消息数', () => {
    const out = shapeAppStateOutput({
      sessionId: 'abc',
      provider: 'deepseek',
      modelId: 'deepseek-chat',
      thinkingLevel: 'high',
      messageCount: 7,
      hasExtensions: false,
    })
    expect(out).toContain('deepseek-chat')
    expect(out).toContain('deepseek')
    expect(out).toContain('思考档位 high')
    expect(out).toContain('7 条消息')
  })
})

describe('shapeTodoOutput（pi_todo_state 真形状）', () => {
  it('schema null = 空态（区分"没建过"与"建过空的"）', () => {
    expect(shapeTodoOutput({ schema: null, list: null, summary: '' })).toContain('没有待办')
  })

  it('有清单 = summary 行 + 清单 JSON', () => {
    const list = { items: [{ content: 'a', status: 'pending' }], currentIndex: 0 }
    const out = shapeTodoOutput({ schema: 'todo_list.v1', list, summary: '0/1 完成' })
    expect(out).toContain('0/1 完成')
    expect(out).toContain('"content":"a"')
  })
})

describe('shapeCronJobsOutput（pi_cron_jobs 真形状）', () => {
  it('行文带 id（run_cron_job_now 的入参来源）/状态/计划', () => {
    const out = shapeCronJobsOutput({
      jobs: [
        {
          id: 'job-1',
          name: '每日简报',
          state: 'scheduled',
          enabled: true,
          schedule_display: '每天 09:00',
          next_run_at: '2026-11-14T01:00:00Z',
          last_status: 'ok',
        },
        { id: 'job-2', name: '暂停的', state: 'paused', enabled: true, schedule_display: '每周一' },
      ],
      tickerRunning: true,
    })
    expect(out).toContain('共 2 个定时任务')
    expect(out).toContain('id=job-1')
    expect(out).toContain('每天 09:00')
    expect(out).toContain('下次 2026-11-14T01:00:00Z')
    expect(out).toContain('已暂停')
  })

  it('空列表 = 空态', () => {
    expect(shapeCronJobsOutput({ jobs: [], tickerRunning: true })).toContain('没有定时任务')
  })
})

describe('shapeCronTriggerOutput（pi_cron_trigger RunOutcome wire）', () => {
  it('skipped = 互斥跳过（不是失败）', () => {
    const out = shapeCronTriggerOutput({ success: false, skipped: true, response: '', error: null })
    expect(out).toContain('被跳过')
  })

  it('失败带原因', () => {
    const out = shapeCronTriggerOutput({ success: false, skipped: false, response: '', error: 'provider 401' })
    expect(out).toContain('运行失败')
    expect(out).toContain('provider 401')
  })

  it('成功截长响应（注明已存档）', () => {
    const out = shapeCronTriggerOutput({
      success: true,
      skipped: false,
      response: 'x'.repeat(600),
      error: null,
      sessionPath: '/s/1',
      outputPath: '/o/1.md',
    })
    expect(out).toContain('任务运行完成')
    expect(out).toContain('结果摘要')
    expect(out).toContain('已完整存档')
    expect(out.length).toBeLessThan(600)
  })

  it('成功无文本 = 明说', () => {
    const out = shapeCronTriggerOutput({ success: true, skipped: false, response: '', error: null })
    expect(out).toContain('没有产生文本结果')
  })
})
