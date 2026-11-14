import { describe, expect, it } from 'vitest';
import { parseTimelineMarkers } from './timeline-marker-store';

describe('parseTimelineMarkers', () => {
  it('接受 modelChange 与 compact 两种形状', () => {
    expect(
      parseTimelineMarkers([
        { kind: 'modelChange', beforeMessageIndex: 0, provider: 'deepseek', modelId: 'r1' },
        { kind: 'compact', beforeMessageIndex: 7 },
      ]),
    ).toEqual([
      { kind: 'modelChange', beforeMessageIndex: 0, provider: 'deepseek', modelId: 'r1' },
      { kind: 'compact', beforeMessageIndex: 7 },
    ]);
  });

  it('非数组直接抛错（不静默当空）', () => {
    expect(() => parseTimelineMarkers({})).toThrow(/不是数组/);
    expect(() => parseTimelineMarkers(null)).toThrow(/不是数组/);
  });

  it('beforeMessageIndex 非非负整数 → 跳过该条', () => {
    const out = parseTimelineMarkers([
      { kind: 'compact', beforeMessageIndex: -1 },
      { kind: 'compact', beforeMessageIndex: 1.5 },
      { kind: 'compact', beforeMessageIndex: '3' },
      { kind: 'compact', beforeMessageIndex: 2 },
    ]);
    expect(out).toEqual([{ kind: 'compact', beforeMessageIndex: 2 }]);
  });

  it('modelChange 缺 provider/modelId → 跳过该条', () => {
    const out = parseTimelineMarkers([
      { kind: 'modelChange', beforeMessageIndex: 1, provider: 'x' },
      { kind: 'modelChange', beforeMessageIndex: 1, provider: 'x', modelId: 'y' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'modelChange', modelId: 'y' });
  });

  it('未知 kind → 跳过，不影响其它条目', () => {
    const out = parseTimelineMarkers([
      { kind: 'goalVerify', beforeMessageIndex: 0 },
      { kind: 'compact', beforeMessageIndex: 0 },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.kind).toBe('compact');
  });

  it('空数组 → 空数组', () => {
    expect(parseTimelineMarkers([])).toEqual([]);
  });
});
