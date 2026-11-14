import { describe, expect, it } from 'vitest';
import {
  summarizeFileChangeTotals,
  summarizeTurnFileChanges,
  type ToolCallPartLike,
} from './turn-file-changes';

const part = (over: Partial<ToolCallPartLike>): ToolCallPartLike => ({
  type: 'tool-call',
  ...over,
});

describe('summarizeTurnFileChanges', () => {
  it('edit 工具从 details.diff 取真值', () => {
    const diff = '+1 const a = 1;\n-2 const a = 0;\n';
    const out = summarizeTurnFileChanges([
      part({
        toolName: 'edit',
        args: { path: 'src/a.ts' },
        result: { details: { diff } },
      }),
    ]);
    expect(out).toEqual([
      { path: 'src/a.ts', additions: 1, deletions: 1, toolNames: ['edit'] },
    ]);
  });

  it('write 工具无 diff → 行数 null（不造 0），文件仍计数', () => {
    const out = summarizeTurnFileChanges([
      part({ toolName: 'write', args: { path: 'src/b.ts' }, result: 'ok' }),
    ]);
    expect(out).toEqual([
      { path: 'src/b.ts', additions: null, deletions: null, toolNames: ['write'] },
    ]);
  });

  it('非写文件工具不入列', () => {
    const out = summarizeTurnFileChanges([
      part({ toolName: 'read', args: { path: 'src/a.ts' } }),
      part({ toolName: 'bash', args: { command: 'ls' } }),
    ]);
    expect(out).toEqual([]);
  });

  it('同文件多次编辑合并并累加行数', () => {
    const out = summarizeTurnFileChanges([
      part({
        toolName: 'edit',
        args: { path: 'src/a.ts' },
        result: { details: { diff: '+1 a\n' } },
      }),
      part({
        toolName: 'hashline_edit',
        args: { path: 'src/a.ts' },
        result: { details: { diff: '+1 b\n-1 c\n' } },
      }),
    ]);
    expect(out).toEqual([
      {
        path: 'src/a.ts',
        additions: 2,
        deletions: 1,
        toolNames: ['edit', 'hashline_edit'],
      },
    ]);
  });

  it('同文件先 edit 后 write：write 无 diff，行数保留 edit 的真值', () => {
    const out = summarizeTurnFileChanges([
      part({
        toolName: 'edit',
        args: { path: 'src/a.ts' },
        result: { details: { diff: '+3 x\n' } },
      }),
      part({ toolName: 'write', args: { path: 'src/a.ts' }, result: 'ok' }),
    ]);
    expect(out).toEqual([
      { path: 'src/a.ts', additions: 1, deletions: 0, toolNames: ['edit', 'write'] },
    ]);
  });

  it('保持首次出现顺序', () => {
    const out = summarizeTurnFileChanges([
      part({ toolName: 'write', args: { path: 'z.ts' }, result: '' }),
      part({ toolName: 'write', args: { path: 'a.ts' }, result: '' }),
    ]);
    expect(out.map((c) => c.path)).toEqual(['z.ts', 'a.ts']);
  });

  it('空输入 → 空数组', () => {
    expect(summarizeTurnFileChanges([])).toEqual([]);
  });
});

describe('summarizeFileChangeTotals', () => {
  it('全有 diff → 聚合行数', () => {
    expect(
      summarizeFileChangeTotals([
        { path: 'a', additions: 2, deletions: 1, toolNames: ['edit'] },
        { path: 'b', additions: 3, deletions: 0, toolNames: ['edit'] },
      ]),
    ).toEqual({ files: 2, additions: 5, deletions: 1 });
  });

  it('全无 diff → 行数 null（不造 0），文件数仍在', () => {
    expect(
      summarizeFileChangeTotals([
        { path: 'a', additions: null, deletions: null, toolNames: ['write'] },
      ]),
    ).toEqual({ files: 1, additions: null, deletions: null });
  });

  it('混合：null 文件不计行数但计文件数', () => {
    expect(
      summarizeFileChangeTotals([
        { path: 'a', additions: 2, deletions: 1, toolNames: ['edit'] },
        { path: 'b', additions: null, deletions: null, toolNames: ['write'] },
      ]),
    ).toEqual({ files: 2, additions: 2, deletions: 1 });
  });

  it('空数组 → 全 null/0', () => {
    expect(summarizeFileChangeTotals([])).toEqual({
      files: 0,
      additions: null,
      deletions: null,
    });
  });
});
