import { describe, expect, it } from 'vitest';
import { subagentLineText } from './subagent-line';

describe('subagentLineText', () => {
  it('单委托：agent + task', () => {
    expect(subagentLineText({ agent: 'explore', task: '找一下入口' })).toEqual({
      name: 'explore',
      task: '找一下入口',
      count: 1,
    });
  });

  it('多任务 tasks[] → count = 任务数', () => {
    expect(
      subagentLineText({ agent: 'worker', task: 'x', tasks: [{}, {}, {}] }),
    ).toMatchObject({ count: 3 });
  });

  it('chain[] 同样计数', () => {
    expect(subagentLineText({ chain: [{}, {}] })).toMatchObject({ count: 2 });
  });

  it('缺 agent → 兜底名「子代理」（不编造名字）', () => {
    expect(subagentLineText({ task: 'x' }).name).toBe('子代理');
    expect(subagentLineText(undefined).name).toBe('子代理');
  });

  it('agent 空白串视同缺失', () => {
    expect(subagentLineText({ agent: '  ' }).name).toBe('子代理');
  });

  it('task 非字符串 → 空串', () => {
    expect(subagentLineText({ agent: 'a', task: 42 }).task).toBe('');
  });
});
