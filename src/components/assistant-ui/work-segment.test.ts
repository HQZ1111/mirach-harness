import { describe, expect, it } from 'vitest';
import {
  formatWorkDuration,
  resolveWorkSegmentStatus,
  turnHasTextAfter,
  workSegmentDefaultOpen,
  workSegmentLabel,
  type WorkPartLike,
} from './work-segment';

const tool = (over: Partial<WorkPartLike> = {}): WorkPartLike => ({
  type: 'tool-call',
  status: { type: 'complete' },
  ...over,
});
const text = (t: string): WorkPartLike => ({ type: 'text', text: t });

describe('resolveWorkSegmentStatus', () => {
  it('有计时 → completed + durationMs', () => {
    expect(
      resolveWorkSegmentStatus([tool({ timing: { startedAt: 1000, completedAt: 4500 } })], [0]),
    ).toEqual({ state: 'completed', durationMs: 3500 });
  });

  it('多子项取 min(start) / max(end)', () => {
    expect(
      resolveWorkSegmentStatus(
        [
          tool({ timing: { startedAt: 2000, completedAt: 3000 } }),
          tool({ timing: { startedAt: 1000, completedAt: 4500 } }),
        ],
        [0, 1],
      ),
    ).toEqual({ state: 'completed', durationMs: 3500 });
  });

  it('任一子项 running → running（不冻结时长）', () => {
    expect(
      resolveWorkSegmentStatus(
        [
          tool({ timing: { startedAt: 1000, completedAt: 2000 } }),
          tool({ timing: { startedAt: 3000 }, status: { type: 'running' } }),
        ],
        [0, 1],
      ),
    ).toEqual({ state: 'running' });
  });

  it('全无计时（纯思考段）→ completed 无时长（不造 0）', () => {
    expect(resolveWorkSegmentStatus([{ type: 'reasoning', text: 'x' }], [0])).toEqual({
      state: 'completed',
    });
  });
});

describe('workSegmentLabel', () => {
  it('running → 工作中 {duration}', () => {
    expect(workSegmentLabel({ state: 'running' }, '3 秒')).toBe('工作中 3 秒');
  });

  it('completed 带时长 → 已工作 {duration}', () => {
    expect(workSegmentLabel({ state: 'completed', durationMs: 3000 }, '3 秒')).toBe(
      '已工作 3 秒',
    );
  });

  it('completed 无时长 → 已处理', () => {
    expect(workSegmentLabel({ state: 'completed' }, null)).toBe('已处理');
  });

  it('interrupted → 已停止', () => {
    expect(workSegmentLabel({ state: 'interrupted' }, '3 秒')).toBe('已停止');
  });
});

describe('workSegmentDefaultOpen', () => {
  it('running 恒开', () => {
    expect(workSegmentDefaultOpen(true, true)).toBe(true);
  });

  it('后面没有正文 → 开（折叠区不能空着）', () => {
    expect(workSegmentDefaultOpen(false, false)).toBe(true);
  });

  it('后面有正文 → 关', () => {
    expect(workSegmentDefaultOpen(true, false)).toBe(false);
  });
});

describe('turnHasTextAfter', () => {
  const msg = (role: string, parts: WorkPartLike[]) => ({ role, parts });

  it('本消息组之后有非空 text → true', () => {
    expect(turnHasTextAfter([msg('assistant', [tool(), text('正文')])], 0, 0)).toBe(true);
  });

  it('本消息组之后只有空 text → false', () => {
    expect(turnHasTextAfter([msg('assistant', [tool(), text('  ')])], 0, 0)).toBe(false);
  });

  it('本轮后续 assistant 消息有正文 → true', () => {
    expect(
      turnHasTextAfter(
        [msg('assistant', [tool()]), msg('assistant', [text('最终回答')])],
        0,
        0,
      ),
    ).toBe(true);
  });

  it('遇到下一条 user 即停（下一轮的正文不算）', () => {
    expect(
      turnHasTextAfter(
        [msg('assistant', [tool()]), msg('user', [text('下一轮')]), msg('assistant', [text('后话')])],
        0,
        0,
      ),
    ).toBe(false);
  });

  it('组内下标之后的 text 才算', () => {
    expect(turnHasTextAfter([msg('assistant', [text('在前'), tool()])], 0, 1)).toBe(false);
    expect(turnHasTextAfter([msg('assistant', [text('在前'), tool(), text('在后')])], 0, 1)).toBe(
      true,
    );
  });
});

describe('formatWorkDuration', () => {
  it('不足 1 秒 → <1 秒', () => {
    expect(formatWorkDuration(400)).toBe('<1 秒');
  });

  it('秒', () => {
    expect(formatWorkDuration(3000)).toBe('3 秒');
  });

  it('整分', () => {
    expect(formatWorkDuration(120_000)).toBe('2 分');
  });

  it('分 + 秒', () => {
    expect(formatWorkDuration(63_000)).toBe('1 分 3 秒');
  });
});
