/**
 * 消息列表 → 轮（turn）单元投影（纯函数，可单测）。
 *
 * ## 为什么要这一层
 *
 * 宿主原本是**扁平消息列表**：`ThreadPrimitive.Messages` 逐条渲染，每条
 * assistant 消息各自挂一条操作条。ZCode 是**轮结构**（
 * `ConversationTurnRenderUnit`，见 `packages/ui/src/v4/
 * conversationTurnRenderUnits.ts`）：一个 turn = 一条 user 输入 + 其后的
 * 全部 assistant 工作，轮尾只有**一条**操作条、一份文件变更汇总。
 *
 * 没有轮层，就做不出轮级操作条、轮尾汇总、轮导航器——这些都以"这一轮
 * 从哪到哪"为前提。
 *
 * ## 分组规则（照 ZCode 的语义，但数据源不同）
 *
 * ZCode 的轮边界来自协议里的 `row.turnId`（CLI 投影权威裁决）。宿主没有
 * 这个字段：pi 的会话是消息序列，没有 turn 概念。等价的推导是
 * **"一条 user 消息开启一轮"**——这与 ZCode 里 turnHeader 由 user 输入
 * 触发的时序一致，且不需要改引擎。
 *
 * - `user` 消息 → 收尾当前轮，开启新轮（key = 该 user 消息 id）。
 * - `assistant` 消息 → 归入当前轮；开头没有 user 前缀的（打开历史会话
 *   时的截断、或只有 assistant 的续写段）自成一轮，`userId = null`。
 * - **空 assistant 消息照样归组**：它是 `RUN_STARTED` 的占位（
 *   `turn-actor.ts` 的 reduce 无条件 push），渲染层自己会 `return null`。
 *   分组层不预判内容，只按 role 切。
 *
 * ## key 只依赖稳定 id
 *
 * ZCode 同款理由（`createDraftUnit` 注释）：流式期间消息**内容**每帧都变，
 * 但 id 序列不变。key 若掺进内容或位置，每次增量都会把轮当成新节点重挂，
 * 丢掉子树状态（折叠态、耗时计时）。所以 key = 开轮那条 user 消息的 id。
 */
export interface TurnUnitInput {
  id: string;
  role: string;
}

export interface ThreadTurn {
  /** React key：开轮那条 user 消息的 id（孤儿轮 = `orphan:<首条 assistant id>`） */
  key: string;
  /** 开启该轮的 user 消息 id；null = 无 user 前缀的孤儿轮 */
  userId: string | null;
  /** 该轮全部消息 id（含 user），保持 thread 顺序 */
  messageIds: readonly string[];
}

/** 按「一条 user 消息开一轮」切分消息序列。 */
export function groupMessagesIntoTurns(
  messages: readonly TurnUnitInput[],
): ThreadTurn[] {
  const turns: ThreadTurn[] = [];
  let current: { key: string; userId: string | null; messageIds: string[] } | null =
    null;

  for (const m of messages) {
    if (m.role === 'user') {
      if (current) turns.push(current);
      current = { key: m.id, userId: m.id, messageIds: [m.id] };
      continue;
    }
    // 非 user（assistant / system）归入当前轮；没有当前轮就先开孤儿轮
    if (!current) {
      current = { key: `orphan:${m.id}`, userId: null, messageIds: [] };
    }
    current.messageIds.push(m.id);
  }
  if (current) turns.push(current);
  return turns;
}

/**
 * 某条 assistant 消息是否为「本轮最后一条有正文的 assistant」。
 *
 * ZCode 用它决定操作条归属（`hideAssistantActions={!item.latest}`）：一轮
 * 只在**最新那条有正文的 assistant 文本**下面挂一次操作条，中途的
 * assistant 段（工具调用前后穿插的短文本）不挂。
 *
 * 判定从该消息往后扫：遇到下一条 user = 本轮结束（是最后一条）；遇到
 * 后面还有正文的 assistant = 不是最后一条。
 *
 * @param messages    thread 消息序列（按 thread 顺序）
 * @param index       待判定的消息下标
 * @param hasContent  正文判定；缺省读 `parts.length > 0`（assistant-ui 的
 *                    MessageState 形状）。测试传自定义判定即可，不必构造
 *                    parts 数组——组件侧因此**不需要 map 一遍全量消息**。
 */
export function isLastContentAssistantOfTurn(
  messages: readonly { role: string; parts?: readonly unknown[] }[],
  index: number,
  hasContent: (m: { role: string; parts?: readonly unknown[] }) => boolean = (m) =>
    (m.parts?.length ?? 0) > 0,
): boolean {
  for (let i = index + 1; i < messages.length; i++) {
    const m = messages[i];
    if (!m) continue;
    if (m.role === 'user') return true;
    if (m.role === 'assistant' && hasContent(m)) return false;
  }
  return true;
}
