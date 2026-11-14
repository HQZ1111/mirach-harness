/**
 * 助手消息工作项扫描——ZCode `buildAssistantWorkRenderItems`
 * （packages/ui/src/v4/conversationAssistantWorkItems.ts）的宿主投影，
 * 2026-11-07。替换 `MessagePrimitive.GroupedParts` 的相邻合并：
 *
 * ## 为什么不能再用 GroupedParts
 *
 * GroupedParts 按**相邻部件的分组路径**合并，任何插入部件断组。ZCode 的
 * 工具族组之所以能跨思考行，是它把**隐藏的 reasoning 行在扫描前剔除**
 * （visibleRows filter）——「思考 · N 秒」默认只显示每条消息第一条
 * （`messageStreamShowReasoning=false` → `messageStreamFirstReasoningRowId`），
 * 隐藏行不渲染、不断组。宿主此前恒为 show-all，`[思考, bash, 思考, bash]`
 * 被拆成两个单子项组各自摊平。
 *
 * ## 规则（每条都有 ZCode 出处）
 *
 * 1. **思考可见性**：`showAllReasoning=false`（ZCode 默认）时只有**第一条**
 *    reasoning 可见，其余从流中剔除——不渲染、不断组、不进工作段时长
 *    （`isConversationReasoningRowVisible`，conversationRowContext.ts）。
 * 2. **工作段**（fold 单位）= 极大连续工作部件运行（reasoning + tool-call），
 *    被任何 standalone 部件（text/file/image/data…）打断——对应 ZCode 的
 *    assistantHistory 运行，正文（assistantText）在折叠区外。
 * 3. **族组**（查阅/终端/更改）：段内连续**同族** tool-call；被可见
 *    reasoning / 异族工具 / 任务工具打断（`isExploreToolCallRow` 谓词同款：
 *    「下一行不是同族 tool-call 就 break」）。
 * 4. **单子项不成父组**：族运行长度 1 → 退回原始工具行（ZCode 三处
 *    builder 的 `length === 1 → 保持原始工具行`）。
 * 5. **任务工具**：带嵌套会话（`messages !== undefined`）且无注册 UI 的
 *    tool-call → task 项（`taskAwareGroupBy` 的判定原样保留）。
 * 6. **组键锚定到首子项下标**：流式追加只动尾部，首下标不变 → 子树不重挂
 *    （ZCode `key: \`explore:${firstRow.rowId}\`` 同语义；宿主不重排消息，
 *    用下标即可，ZCode 用 rowId 是为虚拟列表跨重排）。
 */

/** 工具族（ZCode 三类）。 */
export type ToolFamily = 'explore' | 'execute' | 'changes';

/** 扫描输入的部件最小形状（MessageState.parts 结构兼容）。 */
export interface WorkPartLike {
  type: string;
  toolName?: string;
  /** 工具参数（族分类的只读 shell 判定需要——bash 是否 explore 看命令）。 */
  args?: unknown;
  /** 嵌套会话标记（task 工具）——原 `taskAwareGroupBy` 的判定字段。 */
  messages?: unknown;
  status?: { type?: string };
}

/** 工作段内的一条目。 */
export type WorkEntry =
  | { kind: 'reasoning'; key: string; indices: readonly number[] }
  | { kind: 'tool'; key: string; index: number }
  | { kind: 'family'; key: string; family: ToolFamily; indices: readonly number[] }
  | { kind: 'task'; key: string; index: number };

/** 渲染项：工作段（折叠单位）或 standalone 部件。 */
export type WorkItem =
  | {
      kind: 'segment';
      key: string;
      /** 段内全部**可见**工作部件下标（隐藏 reasoning 不在内——不计时长）。 */
      indices: readonly number[];
      children: readonly WorkEntry[];
    }
  | { kind: 'part'; key: string; index: number };

export interface BuildWorkItemsOptions {
  /** 部件 → 族；'other' = 不聚合（宿主 `classifyToolFamily(toolName, args)`）。 */
  isFamily: (part: WorkPartLike) => ToolFamily | 'other';
  /**
   * 是否显示全部思考（ZCode `messageStreamShowReasoning`）。默认 false =
   * ZCode 默认形态：只显示首条 reasoning，其余剔除。打开后行为回到
   * show-all（可见 reasoning 会打断族组——ZCode 开此设置后同样断组）。
   */
  showAllReasoning?: boolean;
  /**
   * 任务工具判定（默认 `part.messages !== undefined` 且非 standalone；
   * 仅当消费者提供 TaskGroup 槽位时由调用方开启——与旧 taskAwareGroupBy
   * 的启用条件一致：未提供 TaskGroup 时任务工具按普通工具渲染）。
   */
  isTaskPart?: (part: WorkPartLike) => boolean;
}

/** 首条可见 reasoning 之外的全部 reasoning 下标（剔除集）。 */
export function hiddenReasoningIndices(
  parts: readonly WorkPartLike[],
  showAllReasoning: boolean,
): Set<number> {
  const hidden = new Set<number>();
  if (showAllReasoning) return hidden;
  let seenFirst = false;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i]?.type !== 'reasoning') continue;
    if (!seenFirst) {
      seenFirst = true;
      continue;
    }
    hidden.add(i);
  }
  return hidden;
}

/**
 * 扫描消息部件 → 渲染项。纯函数；`parts` 引用稳定时输出引用也稳定
 * （每次新建数组，调用方 useMemo 按 parts 指纹缓存）。
 */
export function buildAssistantWorkItems(
  parts: readonly WorkPartLike[],
  options: BuildWorkItemsOptions,
): readonly WorkItem[] {
  const hidden = hiddenReasoningIndices(parts, options.showAllReasoning === true);
  const isTask = options.isTaskPart;

  const items: WorkItem[] = [];
  let segment: { indices: number[]; entries: WorkEntry[] } | null = null;

  const closeSegment = () => {
    if (!segment) return;
    if (segment.indices.length > 0) {
      items.push({
        kind: 'segment',
        key: `seg:${segment.indices[0]}`,
        indices: segment.indices,
        children: segment.entries,
      });
    }
    segment = null;
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (part.type === 'reasoning') {
      if (hidden.has(i)) continue; // 剔除：不渲染、不断段、不计时长
      // 可见 reasoning：工作段内的思考行（打断族组）
      if (!segment) segment = { indices: [], entries: [] };
      segment.indices.push(i);
      const last = segment.entries[segment.entries.length - 1];
      if (last?.kind === 'reasoning') {
        // 相邻可见 reasoning 合并成一个思考行（旧 group-reasoning 同语义）
        last.indices = [...last.indices, i];
      } else {
        segment.entries.push({ kind: 'reasoning', key: `rsn:${i}`, indices: [i] });
      }
      continue;
    }
    if (part.type === 'tool-call') {
      if (!segment) segment = { indices: [], entries: [] };
      segment.indices.push(i);
      const family = options.isFamily(part);
      // 任务工具**优先于族分组**（旧 taskAwareGroupBy：`path.length > 0`
      // 的任何 tool-call 带 messages 且无注册 UI → task——不看族）；
      // 是否有注册 UI 由调用方的 isTaskPart 一并判定。
      if (isTask?.(part) === true) {
        segment.entries.push({ kind: 'task', key: `task:${i}`, index: i });
        continue;
      }
      const last = segment.entries[segment.entries.length - 1];
      if (family !== 'other' && last?.kind === 'family' && last.family === family) {
        last.indices = [...last.indices, i];
        continue;
      }
      if (family !== 'other') {
        segment.entries.push({
          kind: 'family',
          key: `fam:${family}:${i}`,
          family,
          indices: [i],
        });
        continue;
      }
      segment.entries.push({ kind: 'tool', key: `tool:${i}`, index: i });
      continue;
    }
    // standalone 部件（text/file/image/data/…）：打断工作段，自己在外
    closeSegment();
    items.push({ kind: 'part', key: `part:${i}`, index: i });
  }
  closeSegment();
  return items;
}

/**
 * 组摘要（旧 `GroupedPart` 槽位的形状来源——官方 `getGroupSummary` 逐行
 * 复刻，`counts` 四键同源）：status = 任一 running 则 running，否则取
 * 最后一个部件的 status。自定义 ReasoningGroup/TaskGroup 槽位消费。
 */
export function groupSummary(
  parts: readonly { status?: { type?: string } }[],
  indices: readonly number[],
): {
  status: { type: string };
  counts: { running: number; complete: number; incomplete: number; requiresAction: number };
} {
  const counts = { running: 0, complete: 0, incomplete: 0, requiresAction: 0 };
  let status: { type: string } = { type: 'complete' };
  let isRunning = false;
  for (const index of indices) {
    const s = parts[index]?.status ?? { type: 'complete' };
    status = s as { type: string };
    switch (s.type) {
      case 'running':
        counts.running++;
        isRunning = true;
        break;
      case 'complete':
        counts.complete++;
        break;
      case 'incomplete':
        counts.incomplete++;
        break;
      case 'requires-action':
        counts.requiresAction++;
        break;
    }
  }
  return { status: isRunning ? { type: 'running' } : status, counts };
}
