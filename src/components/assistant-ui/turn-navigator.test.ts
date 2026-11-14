import { describe, expect, it } from 'vitest';
import {
  buildTurnNavigatorItems,
  resolveNavigatorActiveIndex,
  resolveNavigatorBarVisualState,
} from './turn-navigator';

describe('resolveNavigatorBarVisualState（ZCode 同值断言）', () => {
  it('无 hover → idle（opacity 0.58 / scaleX 1）', () => {
    expect(resolveNavigatorBarVisualState({ itemIndex: 3, visualFocusItemIndex: undefined })).toEqual({
      colorTone: 'muted',
      opacity: 0.58,
      scaleX: 1,
      tone: 'idle',
    });
  });

  it('距离 0 → peak（focus / 1 / 2.6）', () => {
    expect(resolveNavigatorBarVisualState({ itemIndex: 2, visualFocusItemIndex: 2 })).toEqual({
      colorTone: 'focus',
      opacity: 1,
      scaleX: 2.6,
      tone: 'peak',
    });
  });

  it('距离 1 → near（0.86 / 1.7）', () => {
    expect(resolveNavigatorBarVisualState({ itemIndex: 3, visualFocusItemIndex: 2 })).toEqual({
      colorTone: 'muted',
      opacity: 0.86,
      scaleX: 1.7,
      tone: 'near',
    });
  });

  it('距离 2 → mid（0.72 / 1.25）', () => {
    expect(resolveNavigatorBarVisualState({ itemIndex: 0, visualFocusItemIndex: 2 })).toEqual({
      colorTone: 'muted',
      opacity: 0.72,
      scaleX: 1.25,
      tone: 'mid',
    });
  });

  it('距离 ≥3 → idle', () => {
    expect(resolveNavigatorBarVisualState({ itemIndex: 0, visualFocusItemIndex: 5 })).toEqual({
      colorTone: 'muted',
      opacity: 0.58,
      scaleX: 1,
      tone: 'idle',
    });
  });
});

describe('buildTurnNavigatorItems', () => {
  it('只收 user 消息（孤儿 assistant 轮不进目录）', () => {
    expect(
      buildTurnNavigatorItems([
        { id: 'a0', role: 'assistant' },
        { id: 'u1', role: 'user' },
        { id: 'a1', role: 'assistant' },
        { id: 'u2', role: 'user' },
      ]),
    ).toEqual([{ key: 'u1' }, { key: 'u2' }]);
  });

  it('空输入 → 空', () => {
    expect(buildTurnNavigatorItems([])).toEqual([]);
  });
});

describe('resolveNavigatorActiveIndex', () => {
  it('最后一个越过判定线的项', () => {
    expect(resolveNavigatorActiveIndex([200, 900, 1600], 400)).toBe(0);
    expect(resolveNavigatorActiveIndex([200, 900, 1600], 1000)).toBe(1);
    expect(resolveNavigatorActiveIndex([200, 900, 1600], 5000)).toBe(2);
  });

  it('全部未越过 → -1', () => {
    expect(resolveNavigatorActiveIndex([900, 1600], 400)).toBe(-1);
  });

  it('空 → -1', () => {
    expect(resolveNavigatorActiveIndex([], 400)).toBe(-1);
  });
});
