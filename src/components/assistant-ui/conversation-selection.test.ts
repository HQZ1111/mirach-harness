import { describe, expect, it } from 'vitest';
import {
  CONVERSATION_SELECTION_MAX_TEXT_LENGTH,
  formatQuoteForComposer,
  guardSelectionCandidate,
  resolveSelectionMenuPosition,
} from './conversation-selection';

const ok = {
  enabled: true,
  sameRow: true,
  insideRoot: true,
  excluded: false,
  text: '选中文字',
  hasLayout: true,
};

describe('guardSelectionCandidate', () => {
  it('全部条件满足 → eligible', () => {
    expect(guardSelectionCandidate(ok)).toBe('eligible');
  });

  it('任一前提不满足 → ineligible', () => {
    for (const key of ['enabled', 'sameRow', 'insideRoot', 'hasLayout'] as const) {
      expect(guardSelectionCandidate({ ...ok, [key]: false })).toBe('ineligible');
    }
    expect(guardSelectionCandidate({ ...ok, excluded: true })).toBe('ineligible');
    expect(guardSelectionCandidate({ ...ok, text: '' })).toBe('ineligible');
  });

  it(`超过 ${CONVERSATION_SELECTION_MAX_TEXT_LENGTH} 字 → single-limit（警告态，不渲染按钮）`, () => {
    expect(
      guardSelectionCandidate({ ...ok, text: 'x'.repeat(CONVERSATION_SELECTION_MAX_TEXT_LENGTH) }),
    ).toBe('eligible');
    expect(
      guardSelectionCandidate({
        ...ok,
        text: 'x'.repeat(CONVERSATION_SELECTION_MAX_TEXT_LENGTH + 1),
      }),
    ).toBe('single-limit');
  });
});

describe('resolveSelectionMenuPosition', () => {
  it('上方放得下 → 选区上方（top − 高 − 8）', () => {
    expect(resolveSelectionMenuPosition({ centerX: 400, top: 300, bottom: 320 }, 200, 36, 1000, 800)).toEqual({
      left: 300,
      top: 256,
    });
  });

  it('上方放不下 → 选区下方（bottom + 8）', () => {
    expect(resolveSelectionMenuPosition({ centerX: 400, top: 30, bottom: 40 }, 200, 36, 1000, 800)).toEqual({
      left: 300,
      top: 48,
    });
  });

  it('水平贴边夹 12px', () => {
    expect(resolveSelectionMenuPosition({ centerX: 20, top: 300, bottom: 320 }, 200, 36, 1000, 800).left).toBe(12);
    expect(resolveSelectionMenuPosition({ centerX: 990, top: 300, bottom: 320 }, 200, 36, 1000, 800).left).toBe(788);
  });

  it('下方越界夹视口（极端矮视口时保底 12px，允许溢出）', () => {
    expect(
      resolveSelectionMenuPosition({ centerX: 400, top: 30, bottom: 40 }, 200, 36, 1000, 50).top,
    ).toBe(12);
  });
});

describe('formatQuoteForComposer', () => {
  it('逐行加 > 并以空行结尾', () => {
    expect(formatQuoteForComposer('第一行\n第二行')).toBe('> 第一行\n> 第二行\n\n');
  });

  it('单行', () => {
    expect(formatQuoteForComposer('单行')).toBe('> 单行\n\n');
  });
});
