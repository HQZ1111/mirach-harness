import { describe, expect, it } from 'vitest';
import {
  bucketMarkers,
  compactionRowView,
  compactionTokenSummary,
  markerLabel,
} from './timeline-marker';
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

describe('compactionTokenSummary / compactionRowView（上下文压缩行）', () => {
  it('tokensBefore → tokensAfter（en-US 千分位）；只有一个就只报一个', () => {
    expect(compactionTokenSummary({ tokensBefore: 12345, tokensAfter: 3210 })).toBe(
      '12,345 → 3,210 tokens',
    );
    expect(compactionTokenSummary({ tokensBefore: 12345 })).toBe('12,345 tokens');
    expect(compactionTokenSummary({})).toBeUndefined();
  });

  it('start → 正在压缩上下文（running，无状态色）', () => {
    expect(compactionRowView({ phase: 'start' })).toEqual({
      label: '正在压缩上下文',
      running: true,
      tone: 'default',
    });
  });

  it('end 成功 → 上下文已压缩 · tokens', () => {
    expect(
      compactionRowView({ phase: 'end', tokensBefore: 1000, tokensAfter: 200 }),
    ).toEqual({
      label: '上下文已压缩 · 1,000 → 200 tokens',
      running: false,
      tone: 'default',
    });
    expect(compactionRowView({ phase: 'end' }).label).toBe('上下文已压缩');
  });

  it('end 中断 → 琥珀色中断文案', () => {
    expect(compactionRowView({ phase: 'end', aborted: true })).toMatchObject({
      label: '上下文压缩已中断',
      tone: 'warning',
    });
  });

  it('end 失败 → 红色失败文案 + 错误原因独立行', () => {
    expect(
      compactionRowView({ phase: 'end', errorMessage: 'provider 超时' }),
    ).toEqual({
      label: '上下文压缩失败',
      running: false,
      tone: 'error',
      detail: 'provider 超时',
    });
  });
});

describe('bucketMarkers', () => {  const mc = (idx: number, provider: string, modelId: string): TimelineMarker => ({
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
