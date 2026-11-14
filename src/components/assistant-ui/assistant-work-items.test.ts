import { describe, expect, it } from 'vitest';
import {
  buildAssistantWorkItems,
  groupSummary,
  hiddenReasoningIndices,
  type WorkPartLike,
} from './assistant-work-items';

/** 宿主族分类的测试替身（与 tool-grouping.ts 的 classifyToolFamily 同表）。 */
const isFamily = (part: WorkPartLike) => {
  if (part.toolName === 'read' || part.toolName === 'ls') return 'explore' as const;
  if (part.toolName === 'bash') return 'execute' as const;
  if (part.toolName === 'edit') return 'changes' as const;
  return 'other' as const;
};

const reasoning = (): WorkPartLike => ({ type: 'reasoning' });
const tool = (toolName: string, messages?: unknown): WorkPartLike => ({
  type: 'tool-call',
  toolName,
  ...(messages !== undefined ? { messages } : {}),
});
const text = (): WorkPartLike => ({ type: 'text' });

const build = (parts: readonly WorkPartLike[], showAllReasoning = false) =>
  buildAssistantWorkItems(parts, { isFamily, showAllReasoning });

describe('hiddenReasoningIndices', () => {
  it('默认只显示首条 reasoning（ZCode messageStreamShowReasoning=false）', () => {
    expect(hiddenReasoningIndices([reasoning(), reasoning(), reasoning()], false)).toEqual(
      new Set([1, 2]),
    );
  });

  it('showAllReasoning=true → 无隐藏', () => {
    expect(hiddenReasoningIndices([reasoning(), reasoning()], true)).toEqual(new Set());
  });

  it('非 reasoning 部件不影响首条判定', () => {
    expect(hiddenReasoningIndices([text(), reasoning(), reasoning()], false)).toEqual(
      new Set([2]),
    );
  });
});

describe('buildAssistantWorkItems', () => {
  it('核心场景：[思考, bash, 思考, bash] → 一个工作段，隐藏思考剔除，bash 合成一个族组', () => {
    const items = build([reasoning(), tool('bash'), reasoning(), tool('bash')]);
    expect(items).toHaveLength(1);
    const seg = items[0]!;
    expect(seg.kind).toBe('segment');
    if (seg.kind !== 'segment') return;
    // 隐藏的思考（下标 2）不进段——不计工作时长
    expect(seg.indices).toEqual([0, 1, 3]);
    expect(seg.children).toHaveLength(2);
    expect(seg.children[0]).toMatchObject({ kind: 'reasoning', indices: [0] });
    expect(seg.children[1]).toMatchObject({
      kind: 'family',
      family: 'execute',
      indices: [1, 3],
    });
  });

  it('可见思考打断族组（showAllReasoning）——与 ZCode 开此设置后同构', () => {
    const items = build(
      [reasoning(), tool('bash'), reasoning(), tool('bash')],
      true,
    );
    const seg = items[0]!;
    if (seg.kind !== 'segment') return expect.fail('expected segment');
    // 全部可见 → 段含 4 部件；族组被思考打断成两个单子项
    expect(seg.indices).toEqual([0, 1, 2, 3]);
    expect(seg.children).toEqual([
      { kind: 'reasoning', key: 'rsn:0', indices: [0] },
      { kind: 'family', key: 'fam:execute:1', family: 'execute', indices: [1] },
      { kind: 'reasoning', key: 'rsn:2', indices: [2] },
      { kind: 'family', key: 'fam:execute:3', family: 'execute', indices: [3] },
    ]);
  });

  it('单子项族组仍以 family 形态给出（摊平是渲染层职责）', () => {
    const items = build([reasoning(), tool('bash')]);
    const seg = items[0]!;
    if (seg.kind !== 'segment') return expect.fail('expected segment');
    expect(seg.children).toEqual([
      { kind: 'reasoning', key: 'rsn:0', indices: [0] },
      { kind: 'family', key: 'fam:execute:1', family: 'execute', indices: [1] },
    ]);
  });

  it('异族工具互相打断（ZCode 谓词：下一行不是同族就 break）', () => {
    const items = build([tool('read'), tool('bash'), tool('read')]);
    const seg = items[0]!;
    if (seg.kind !== 'segment') return expect.fail('expected segment');
    expect(seg.children.map((c) => c.kind)).toEqual(['family', 'family', 'family']);
    if (
      seg.children[0]!.kind === 'family' &&
      seg.children[1]!.kind === 'family' &&
      seg.children[2]!.kind === 'family'
    ) {
      expect(seg.children[0].indices).toEqual([0]);
      expect(seg.children[1].indices).toEqual([1]);
      expect(seg.children[2].indices).toEqual([2]);
    }
  });

  it('text 打断工作段：正文在折叠区外', () => {
    const items = build([tool('bash'), text(), tool('bash')]);
    expect(items).toHaveLength(3);
    expect(items[0]!.kind).toBe('segment');
    expect(items[1]).toEqual({ kind: 'part', key: 'part:1', index: 1 });
    expect(items[2]!.kind).toBe('segment');
  });

  it('隐藏思考不打断 text→工具 的段边界语义（剔除后按可见流扫描）', () => {
    // [text, thinking(hidden? 否——首条可见), bash]：首条思考可见，在段内
    const items = build([text(), reasoning(), tool('bash')]);
    expect(items[0]).toEqual({ kind: 'part', key: 'part:0', index: 0 });
    const seg = items[1]!;
    if (seg.kind !== 'segment') return expect.fail('expected segment');
    expect(seg.indices).toEqual([1, 2]);
  });

  it('段键锚定首部件下标（流式追加不重挂）', () => {
    const a = build([reasoning(), tool('bash')]);
    const more = build([reasoning(), tool('bash'), tool('bash')]);
    expect(a[0]!.kind === 'segment' && a[0]!.key).toBe(
      more[0]!.kind === 'segment' && more[0]!.key,
    );
  });

  it('其它工具（todo/agent/ask…）→ 独立 tool 行，仍在工作段内', () => {
    const items = build([tool('todo'), tool('bash')]);
    const seg = items[0]!;
    if (seg.kind !== 'segment') return expect.fail('expected segment');
    expect(seg.children).toEqual([
      { kind: 'tool', key: 'tool:0', index: 0 },
      { kind: 'family', key: 'fam:execute:1', family: 'execute', indices: [1] },
    ]);
  });

  it('任务工具优先于族分组（旧 taskAwareGroupBy 同判定）', () => {
    const items = buildAssistantWorkItems([tool('bash', { nested: true })], {
      isFamily,
      isTaskPart: (p) => p.messages !== undefined,
    });
    const seg = items[0]!;
    if (seg.kind !== 'segment') return expect.fail('expected segment');
    expect(seg.children).toEqual([{ kind: 'task', key: 'task:0', index: 0 }]);
  });

  it('未提供 isTaskPart 时任务工具按普通工具渲染（旧：无 TaskGroup 槽位即普通工具）', () => {
    const items = build([tool('bash', { nested: true })]);
    const seg = items[0]!;
    if (seg.kind !== 'segment') return expect.fail('expected segment');
    expect(seg.children).toEqual([
      { kind: 'family', key: 'fam:execute:0', family: 'execute', indices: [0] },
    ]);
  });

  it('空输入 → 空', () => {
    expect(build([])).toEqual([]);
  });

  it('纯文本消息 → 全是 part 项', () => {
    expect(build([text(), text()])).toEqual([
      { kind: 'part', key: 'part:0', index: 0 },
      { kind: 'part', key: 'part:1', index: 1 },
    ]);
  });
});

describe('groupSummary（官方 getGroupSummary 逐行复刻）', () => {
  it('任一 running → running', () => {
    expect(
      groupSummary([{ status: { type: 'complete' } }, { status: { type: 'running' } }], [0, 1])
        .status.type,
    ).toBe('running');
  });

  it('无 running → 末部件 status（官方 getGroupSummary 同款）', () => {
    expect(
      groupSummary([{ status: { type: 'complete' } }, { status: { type: 'incomplete' } }], [0, 1])
        .status.type,
    ).toBe('incomplete');
  });

  it('counts 四键计数', () => {
    expect(
      groupSummary(
        [
          { status: { type: 'running' } },
          { status: { type: 'complete' } },
          { status: { type: 'incomplete' } },
          { status: { type: 'requires-action' } },
        ],
        [0, 1, 2, 3],
      ).counts,
    ).toEqual({ running: 1, complete: 1, incomplete: 1, requiresAction: 1 });
  });
});
