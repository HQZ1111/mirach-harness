import { describe, expect, it } from 'vitest';
import {
  findCountLabel,
  nextActiveIndex,
  normalizeQuery,
} from './conversation-find';

describe('findCountLabel', () => {
  it('n/m 形态', () => {
    expect(findCountLabel(0, 3)).toBe('1/3');
    expect(findCountLabel(2, 3)).toBe('3/3');
  });

  it('无匹配 → 0/0', () => {
    expect(findCountLabel(0, 0)).toBe('0/0');
  });

  it('越界夹取', () => {
    expect(findCountLabel(9, 3)).toBe('3/3');
    expect(findCountLabel(-1, 3)).toBe('1/3');
  });
});

describe('nextActiveIndex', () => {
  it('循环前进 / 后退', () => {
    expect(nextActiveIndex(0, 3, 1)).toBe(1);
    expect(nextActiveIndex(2, 3, 1)).toBe(0);
    expect(nextActiveIndex(0, 3, -1)).toBe(2);
  });

  it('无匹配恒 0', () => {
    expect(nextActiveIndex(5, 0, 1)).toBe(0);
    expect(nextActiveIndex(5, 0, -1)).toBe(0);
  });
});

describe('normalizeQuery', () => {
  it('trim + 小写', () => {
    expect(normalizeQuery('  Foo BAR ')).toBe('foo bar');
  });

  it('空串', () => {
    expect(normalizeQuery('   ')).toBe('');
  });
});
