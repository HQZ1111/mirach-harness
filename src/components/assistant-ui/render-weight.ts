/**
 * 消息的「绘制重量」度量（hermes `lib/render-weight.ts` 的宿主版，2026-11-19）。
 *
 * 为什么按重量而不是条数：轮容器的 DOM 数量取决于**分组**，不是 payload。
 * 一组十二个已完成的 read 折叠成一行灰色摘要、思考是一行折叠触发器、todo
 * 被提升到面板外——都不按字节数建 DOM；而 diff 卡、图片卡、大段 markdown
 * 真的会建 DOM。按 payload 计价曾把「从不挂载的工作」也算进预算：一个工具
 * 密集的轮价 84-281 单位，却只画出一打单行摘要，于是整页只装下两三轮。
 *
 * 口径（照抄 hermes `messagePaintWeight`）：
 * - 正文/思考：ceil(字符数 / 512)——字符数近似 markdown 解析、文本节点与
 *   工具输出格式化的成本；
 * - 已落定的工具行：1（折叠成一行）；卡片类工具：6（定尺寸）；todo：0（不渲染）；
 * - 图片/文件/数据部件：6（一个 <img>/chip，与 payload 大小无关）。
 *
 * 测量有界、抗循环：整个消息共享一个字符预算，单个巨型 payload 不能逐个
 * 部件无限遍历——超过「一整页」后再测也改变不了任何一条轮边界。
 */

export const RENDER_WEIGHT_CHARS = 512;

/** 单条消息测完即可跨过一整页（600 单位）的上限。 */
const MAX_MEASURED_MESSAGE_CHARS = 300 * RENDER_WEIGHT_CHARS;

/** 折叠行成本：图标 + 标题（+ 计数）。 */
const COLLAPSED_ROW_WEIGHT = 1;

/** 定尺寸卡片成本：图片卡/问答卡/委托卡。 */
const CARD_WEIGHT = 6;

/** 不渲染的工具（待办在状态面板有专区分区，消息流里不挂）。 */
const SILENT_TOOL_NAMES: ReadonlySet<string> = new Set(["todo", "todo_write", "todos"]);

/** 卡片类呈现的工具名（一行摘要之外的固定尺寸卡片）。 */
const CARD_TOOL_NAMES: ReadonlySet<string> = new Set([
  "ask_user",
  "askuserquestion",
  "ask_question",
  "submit_plan",
  "delegate_task",
  "subagent",
]);

export interface PaintWeightPartLike {
  type?: unknown;
  text?: unknown;
  toolName?: unknown;
  data?: unknown;
  result?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * 任意 payload 的字符成本：有界（budget 用尽即停）、抗循环（WeakSet）、
 * 不把对象结构夸张成 JSON 字符串（只数字符串/数字叶子的长度近似）。
 */
function payloadCharacters(roots: readonly unknown[], budget: number): number {
  const seen = new WeakSet<object>();
  const pending: unknown[] = [...roots];
  let characters = 0;
  while (pending.length > 0 && characters < budget) {
    const value = pending.pop();
    if (typeof value === "string") {
      characters += value.length;
      continue;
    }
    if (typeof value === "number" || typeof value === "bigint") {
      characters += String(value).length;
      continue;
    }
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
      continue;
    }
    for (const item of Object.values(value as Record<string, unknown>)) pending.push(item);
  }
  return Math.min(characters, budget);
}

/** 单个部件（text / reasoning / tool-call / 其它）的绘制成本。 */
export function partPaintWeight(part: PaintWeightPartLike): number {
  const type = typeof part.type === "string" ? (part.type as string) : "";
  if (type === "text" || type === "reasoning") {
    const text = typeof part.text === "string" ? part.text : "";
    return Math.ceil(text.length / RENDER_WEIGHT_CHARS);
  }
  if (type === "tool-call") {
    const name = typeof part.toolName === "string" ? part.toolName.toLowerCase() : "";
    if (SILENT_TOOL_NAMES.has(name)) return 0;
    if (CARD_TOOL_NAMES.has(name)) return CARD_WEIGHT;
    return COLLAPSED_ROW_WEIGHT;
  }
  // image / file / data / source 等：定尺寸 chip/卡片，按 0 或定值计
  if (type === "image" || type === "file" || type === "data") return CARD_WEIGHT;
  return 0;
}

/** 一条消息的绘制成本（部件和，按整页上限截断）。 */
export function messagePaintWeight(message: {
  parts?: readonly PaintWeightPartLike[];
}): number {
  const parts = message.parts ?? [];
  let weight = 0;
  for (const part of parts) {
    weight += partPaintWeight(part);
    if (weight >= MAX_MEASURED_MESSAGE_CHARS) break;
  }
  return Math.min(weight, MAX_MEASURED_MESSAGE_CHARS);
}

/** 兼容 hermes 的 store 口径（payload 近似），宿主会话水合后消息已在内存，
 *  该口径仅用于把「按 payload 计价」与「按挂载计价」区分记录；窗口一律用
 *  messagePaintWeight。 */
export function messageStoreWeight(message: {
  parts?: readonly PaintWeightPartLike[];
}): number {
  return messagePaintWeight(message);
}