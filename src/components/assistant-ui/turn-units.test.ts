import { describe, expect, it } from 'vitest';
import {
  groupMessagesIntoTurns,
  isLastContentAssistantOfTurn,
  type TurnUnitInput,
} from './turn-units';

const msg = (id: string, role: string): TurnUnitInput => ({ id, role });

describe('groupMessagesIntoTurns', () => {
  it('一条 user 开启一轮，其后 assistant 归入该轮', () => {
    const turns = groupMessagesIntoTurns([
      msg('u1', 'user'),
      msg('a1', 'assistant'),
      msg('a2', 'assistant'),
      msg('u2', 'user'),
      msg('a3', 'assistant'),
    ]);
    expect(turns.map((t) => t.key)).toEqual(['u1', 'u2']);
    expect(turns[0]!.messageIds).toEqual(['u1', 'a1', 'a2']);
    expect(turns[1]!.messageIds).toEqual(['u2', 'a3']);
    expect(turns[0]!.userId).toBe('u1');
  });

  it('开头没有 user 的 assistant 自成孤儿轮（key 只依赖 id）', () => {
    const turns = groupMessagesIntoTurns([
      msg('a0', 'assistant'),
      msg('a1', 'assistant'),
      msg('u1', 'user'),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]!.key).toBe('orphan:a0');
    expect(turns[0]!.userId).toBeNull();
    expect(turns[0]!.messageIds).toEqual(['a0', 'a1']);
    expect(turns[1]!.key).toBe('u1');
  });

  it('空 assistant 占位照样归组（内容判定不在这层）', () => {
    const turns = groupMessagesIntoTurns([
      msg('u1', 'user'),
      msg('run-1', 'assistant'),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.messageIds).toEqual(['u1', 'run-1']);
  });

  it('空输入 → 空数组', () => {
    expect(groupMessagesIntoTurns([])).toEqual([]);
  });

  it('连续 user 消息各开一轮（编辑重发的中间态）', () => {
    const turns = groupMessagesIntoTurns([
      msg('u1', 'user'),
      msg('u2', 'user'),
      msg('a1', 'assistant'),
    ]);
    expect(turns.map((t) => t.key)).toEqual(['u1', 'u2']);
    expect(turns[0]!.messageIds).toEqual(['u1']);
    expect(turns[1]!.messageIds).toEqual(['u2', 'a1']);
  });

  it('system 消息归入当前轮（与 assistant 同待遇）', () => {
    const turns = groupMessagesIntoTurns([
      msg('u1', 'user'),
      msg('s1', 'system'),
      msg('a1', 'assistant'),
    ]);
    expect(turns[0]!.messageIds).toEqual(['u1', 's1', 'a1']);
  });
});

describe('isLastContentAssistantOfTurn', () => {
  // 组件侧传的是 MessageState（自带 role/parts），所以测试直接用 parts 数组
  // 表达「有正文/无正文」，走默认判定——与生产路径同一条代码。
  const m = (role: string, hasContent = true) => ({
    role,
    parts: hasContent ? [{}] : [],
  });

  it('本轮唯一 assistant → 是最后一条', () => {
    expect(isLastContentAssistantOfTurn([m('user'), m('assistant')], 1)).toBe(true);
  });

  it('后面还有有正文的 assistant → 不是最后一条', () => {
    expect(
      isLastContentAssistantOfTurn(
        [m('user'), m('assistant'), m('assistant')],
        1,
      ),
    ).toBe(false);
  });

  it('后面的 assistant 无正文（空占位）→ 仍是最后一条', () => {
    expect(
      isLastContentAssistantOfTurn(
        [m('user'), m('assistant'), m('assistant', false)],
        1,
      ),
    ).toBe(true);
  });

  it('遇到下一条 user → 本轮结束，是最后一条', () => {
    expect(
      isLastContentAssistantOfTurn(
        [m('user'), m('assistant'), m('user'), m('assistant')],
        1,
      ),
    ).toBe(true);
  });

  it('末尾消息 → 是最后一条', () => {
    expect(isLastContentAssistantOfTurn([m('user'), m('assistant')], 1)).toBe(true);
  });
});
