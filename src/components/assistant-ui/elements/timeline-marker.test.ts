import { describe, expect, it } from 'vitest';
import { bucketMarkers, markerLabel } from './timeline-marker';
import type { TimelineMarker } from '../timeline-marker-store';

describe('markerLabel', () => {
  it('compact → 上下文已压缩', () => {
    expect(markerLabel({ kind: 'compact', beforeMessageIndex: 0 })).toBe('上下文已压缩');
  });

  it('modelChange → 正在使用 provider/model', () => {
    expect(
      markerLabel({
        kind: 'modelChange',
        beforeMessageIndex: 0,
        provider: 'deepseek',
        modelId: 'deepseek-reasoner',
      }),
    ).toBe('正在使用 deepseek/deepseek-reasoner');
  });
});

describe('bucketMarkers', () => {
  const mc = (idx: number, provider: string, modelId: string): TimelineMarker => ({
    kind: 'modelChange',
    beforeMessageIndex: idx,
    provider,
    modelId,
  });

  it('按 beforeMessageIndex 分桶', () => {
    const out = bucketMarkers([
      mc(0, 'a', 'm1'),
      { kind: 'compact', beforeMessageIndex: 5 },
      mc(5, 'b', 'm2'),
    ]);
    expect([...out.keys()].sort((a, b) => a - b)).toEqual([0, 5]);
    expect(out.get(0)).toHaveLength(1);
    expect(out.get(5)).toHaveLength(2);
  });

  it('首个 modelChange 没有 prevModel（渲染「正在使用」）', () => {
    const out = bucketMarkers([mc(0, 'a', 'm1')]);
    expect(out.get(0)![0]!.prevModel).toBeUndefined();
  });

  it('第二个 modelChange 的 prevModel = 前一个 model', () => {
    const out = bucketMarkers([mc(0, 'a', 'm1'), mc(3, 'b', 'm2')]);
    expect(out.get(3)![0]!.prevModel).toBe('a/m1');
  });

  it('compact 不参与 prevModel 推导', () => {
    const out = bucketMarkers([
      mc(0, 'a', 'm1'),
      { kind: 'compact', beforeMessageIndex: 1 },
      mc(2, 'b', 'm2'),
    ]);
    expect(out.get(2)![0]!.prevModel).toBe('a/m1');
  });

  it('乱序输入仍得到正确的前值链', () => {
    const out = bucketMarkers([mc(9, 'b', 'm2'), mc(1, 'a', 'm1')]);
    expect(out.get(1)![0]!.prevModel).toBeUndefined();
    expect(out.get(9)![0]!.prevModel).toBe('a/m1');
  });

  it('空输入 → 空 Map', () => {
    expect(bucketMarkers([]).size).toBe(0);
  });
});
