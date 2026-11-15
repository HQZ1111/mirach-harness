/**
 * 连续工具摘要组（Consecutive Summary Group）——ZCode
 * `packages/ui/src/v4/conversationAssistantWorkItems.ts` 的宿主投影
 * （2026-11-15，替换 2026-11-07 的「族组」扫描）。
 *
 * **2026-11-15 复核**：工作过程是 ZCode 的两层结构——外层每 turn 一个
 * `AssistantHistoryStatus`（只有状态/时长），内层按**连续摘要行**分段建
 * `ConsecutiveSummaryGroup`（统计在组头）。本模块的 `buildWorkSummaryItems`
 * 负责分段（正文/子代理/未归类工具切断组），统计/图标/活动项作用于**单个
 * 组**。下面的规则与 ZCode 逐条对应。
 *
 * ## 与旧「族组」的区别（为什么重写）
 *
 * 旧扫描按**族**分组（explore / execute / changes 三个父组），组头写
 * 「终端 · N 个命令」。ZCode 实际是**连续摘要组**：一段连续的可归类行
 * （思考 + 可归类工具）合成**一个**组，组头是一句统计
 * 「已查阅 20 项，已执行 134 命令，已修改 4 文件」，组内按原顺序呈现
 * 每一行（思考行 / 工具行）。统计跨族，不是每族一个组。
 *
 * ## ZCode 规则（逐条对应，函数名带出处）
 *
 * 1. **可归类行**（`getAssistantSummaryToolCategory`）：思考行恒可归类；
 *    工具行按族归类 —— explore（read/ls/image/grep/find/ast_grep/lsp/
 *    web_search/webfetch）、run（bash/powershell/node-repl）、change
 *    （edit/write/hashline_edit/ast_edit）；会话工具（`session_*`）独立
 *    类别（统计时并入执行数，图标优先级最低）。
 * 2. **边界**（`groupConsecutiveAssistantSummaries`）：正文、子代理 /
 *    委托工具、未归类工具（submit_plan、MCP、工具目录查询…）、图片/文件
 *    部件——都中断当前组。**宿主偏差（2026-11-15 用户定稿）**：pi 在每个
 *    工具批次前都写一段 commentary 正文，严格按 ZCode 断组会把一轮切成
 *    十几个「已执行 N 命令」组头、思考全被折叠藏掉。故宿主把**非空正文
 *    视为组内普通行（不断组）**；子代理/未归类工具仍是边界（语义边界，
 *    不是排版边界）。空文本/空思考直接剔除。
 * 3. **组内 ≥2 才成组**（ZCode 渲染层判 `items.length < 2` 时摊平为单行；
 *    宿主已不建分段组，这条仅保留为扫描语义）。
 * 4. **统计**（`formatAssistantSummaryStatistics`）：explore 计**调用数**；
 *    run + session 计**调用数**；change 按**唯一文件路径**计（词法归一化
 *    去重），无路径计 unresolved；完成态前缀「已」，运行态无前缀；分隔符
 *    「，」；空统计回退「思考」。
 * 5. **代表图标**（`getAssistantSummaryIconItem`）：CUA 0 / node-repl 1 /
 *    change 2 / run 3 / explore（含 session）4，取最小者。
 * 6. **活动项**（`getActiveAssistantSummaryItem`）：组内最后一个仍在流式的
 *    思考 / 运行中的工具；组头 `current = active ?? last`（渲染层
 *    `SummaryRunView` 直接取 `active ?? indices.at(-1)`）。
 * 7. **折叠变更摘要**（`getAssistantSummaryChangeFiles`）：只有**纯 change
 *    组**（组内每条都是 change，或思考）才返回文件清单；混入别的族即
 *    undefined。
 *
 * 全部为纯函数（无 React / 无 DOM），中文文案与 ZCode `zh-CN.ts` 逐条一致。
 */

/** 部件最小形状（assistant-ui MessageState.parts 的消费子集）。 */
export interface SummaryPartLike {
  type: string;
  /** text / reasoning 正文 */
  text?: string;
  toolName?: string;
  toolCallId?: string;
  /** 工具参数（pi `arguments` → ReadonlyJSONObject） */
  args?: unknown;
  /** 工具结果（ToolOutput 对象或字符串） */
  result?: unknown;
  isError?: boolean;
  /** assistant-ui 部件状态（running / complete / incomplete / requires-action） */
  status?: { type?: string };
  /** 工具计时（convertTurnMessage 由 TurnPart.startedAt/completedAt 写入） */
  timing?: { startedAt?: number; completedAt?: number };
}

/** 摘要类别（ZCode 四类；null = 不可归类 = 边界）。 */
export type SummaryCategory = 'explore' | 'run' | 'change' | 'session' | null;

/** 工具名 → 摘要类别。工具表按 pi 的 rpi-tools（与 tool-renderers 分流同源）。 */
const EXPLORE_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'ls',
  'image',
  'grep',
  'find',
  'ast_grep',
  'lsp',
  'web_search',
  // rpi 的网页搜索扩展工具名是 `websearch`（无下划线，与内核 web_search
  // 不同；见 tool-presentation/tool-specs.ts:202 的实测注释）。
  'websearch',
  'webfetch',
  'web_fetch',
  'fetch',
  'list_files',
  'glob',
]);

const RUN_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'powershell',
  'shell',
  'terminal',
  'node_repl',
  'node-repl',
  'repl',
]);

const CHANGE_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'hashline_edit',
  'ast_edit',
  'multiedit',
  'multi_edit',
]);

/** 会话工具（ZCode `isSessionToolName` 的宿主口径：pi/rpi 的 `session_*`）。 */
export function isSessionToolName(toolName: string): boolean {
  return toolName === 'session' || toolName.startsWith('session_') || toolName.startsWith('session-');
}

/** 子代理 / 委托工具（ZCode `SUBAGENT_TOOL_NAMES`）——恒为边界，不进口组。 */
const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Agent',
  'Task',
  'subagent',
  'delegate_task',
]);

export function isSubagentToolName(toolName: string): boolean {
  return SUBAGENT_TOOL_NAMES.has(toolName);
}

/** 待办工具不进消息流（ZCode `messageStreamShowTodos` 默认 false 的剔除）。 */
export function isTodoToolName(toolName: string): boolean {
  return toolName === 'todo' || toolName === 'todo_write' || toolName === 'todos';
}

/** 单个部件的摘要类别（ZCode `getAssistantSummaryToolCategory`）。
 * **思考行没有类别**——它可进摘要组（见 isSummaryRow），但不计任何统计数
 * （ZCode 统计循环里 `reasoning` 行的 category 为 null）。 */
export function classifySummaryCategory(part: SummaryPartLike): SummaryCategory {
  if (part.type !== 'tool-call') return null;
  // 待审批的行不参与统计（ZCode：`row.status === "pendingApproval"` → null）
  if (part.status?.type === 'requires-action') return null;
  const toolName = part.toolName ?? '';
  if (isSubagentToolName(toolName)) return null;
  if (isSessionToolName(toolName)) return 'session';
  if (CHANGE_TOOLS.has(toolName)) return 'change';
  if (RUN_TOOLS.has(toolName)) return 'run';
  if (EXPLORE_TOOLS.has(toolName)) return 'explore';
  return null;
}

/** 该部件是否进摘要组（思考行 + 可归类工具）。 */
export function isSummaryRow(part: SummaryPartLike): boolean {
  if (part.type === 'reasoning') return true;
  return classifySummaryCategory(part) !== null;
}

/** 摘要组扫描项：单行（边界部件）或一段连续摘要行。 */
export type WorkSummaryItem =
  | { kind: 'part'; key: string; index: number }
  | { kind: 'rows'; key: string; indices: readonly number[] };

/**
 * 扫描一段部件（工作段内）→ 渲染项序列。
 *
 * 连续的可归类部件合成一个 `rows` 项（**长度 1 也保留 rows**——渲染层按
 * ZCode 的 `items.length < 2` 摊平成普通行）；边界部件各成一个 `part` 项。
 * 待办部件直接剔除（不渲染、不断组——ZCode 在扫描前 filter 掉）。
 */
export function buildWorkSummaryItems(
  parts: readonly SummaryPartLike[],
  indices: readonly number[],
): WorkSummaryItem[] {
  const items: WorkSummaryItem[] = [];
  let current: { indices: number[] } | null = null;
  const close = () => {
    if (!current) return;
    if (current.indices.length > 0) {
      items.push({
        kind: 'rows',
        key: `rows:${current.indices[0]}`,
        indices: current.indices,
      });
    }
    current = null;
  };
  for (const index of indices) {
    const part = parts[index];
    if (!part) continue;
    if (part.type === 'tool-call' && isTodoToolName(part.toolName ?? '')) continue;
    // 空文本 / 空思考不是可见行（ZCode 在扫描前把流式空 reasoning 与空
    // assistantText 剔除）。它们既不渲染，也**不能切断连续摘要组**——
    // 否则每个空 delta 都会多开一个组头，把「已查阅 N 项，已执行 M 命令」
    // 的总项拆碎。
    if ((part.type === 'text' || part.type === 'reasoning') && !(part.text ?? '').trim()) {
      continue;
    }
    if (part.type === 'text') {
      // 非空正文：不断组，作为组内普通行（见模块头「宿主偏差」）。没有
      // 当前组时按边界行内联（正文后面才开始工具段）。
      if (current) current.indices.push(index);
      else items.push({ kind: 'part', key: `part:${index}`, index });
      continue;
    }
    if (isSummaryRow(part)) {
      if (!current) current = { indices: [] };
      current.indices.push(index);
      continue;
    }
    close();
    items.push({ kind: 'part', key: `part:${index}`, index });
  }
  close();
  return items;
}

/** 词法路径归一化（ZCode `summaryFilePath` 的无 workspacePath 口径）：
 * 斜杠统一、消掉 `.` / `..`、去重靠它——**不碰文件系统**。 */
export function normalizeSummaryPath(path: string): string {
  const joined = path.trim().replace(/\\/g, '/');
  if (joined === '') return '';
  const root = joined.startsWith('//')
    ? (joined.match(/^\/\/[^/]+\/[^/]+/)?.[0] ?? '//')
    : (joined.match(/^[A-Za-z]:\//)?.[0] ?? (joined.startsWith('/') ? '/' : ''));
  const parts: string[] = [];
  for (const part of joined.slice(root.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && parts.length && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !root) parts.push(part);
  }
  return root + (root && !root.endsWith('/') && parts.length ? '/' : '') + parts.join('/');
}

/** 从工具参数取文件路径（edit/write/read… 的 `path` 家族）。 */
export function toolArgPath(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'filePath', 'filename', 'file'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/** pi `ToolOutput.details.diff`（tools.rs::generate_diff_string 的输出）。 */
function outputDiffText(result: unknown): string | undefined {
  if (typeof result !== 'object' || result === null) return undefined;
  const details = (result as Record<string, unknown>).details;
  if (typeof details !== 'object' || details === null) return undefined;
  const diff = (details as Record<string, unknown>).diff;
  return typeof diff === 'string' && diff.length > 0 ? diff : undefined;
}

/** pi diff 文本的行计数（与 `diff-parse.ts::parsePiDiff` 同一套 marker 规则；
 * 这里只要计数，不建渲染行——避免纯函数模块依赖渲染元素）。 */
export function countPiDiff(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const raw of diff.split('\n')) {
    if (raw.length === 0) continue;
    const marker = raw[0];
    if (marker === '+') additions++;
    else if (marker === '-') deletions++;
  }
  return { additions, deletions };
}

/** 一个 change 工具改到的文件（路径 + 行数）。 */
export interface SummaryChangedFile {
  path: string;
  additions: number;
  removed: number;
}

/**
 * change 工具 → 文件清单（数据面实测）：
 * - `edit` / `hashline_edit` / `ast_edit`：路径取 args.path，行数取
 *   `ToolOutput.details.diff`（pi tools.rs 的 generate_diff_string）；
 * - `write`：2026-11-15 引擎补丁后同样产 `details.diff`（写前读旧内容），
 *   优先按真实 diff 计数；旧引擎/读不到旧内容（`details.diff_skipped`）时
 *   回退：`additions` = 写入内容行数（写入语义 = 全为新增），`removed` = 0；
 *   无 content 时行数记 0（不编造）。
 * - 参数里没有路径 → null（调用方计 unresolved）。
 */
export function changedFileOf(part: SummaryPartLike): SummaryChangedFile | null {
  if (part.type !== 'tool-call') return null;
  if (classifySummaryCategory(part) !== 'change') return null;
  const path = toolArgPath(part.args);
  if (!path) return null;
  const toolName = part.toolName ?? '';
  const diff = outputDiffText(part.result);
  if (diff !== undefined) {
    const { additions, deletions } = countPiDiff(diff);
    return { path, additions, removed: deletions };
  }
  if (toolName === 'write' && typeof part.args === 'object' && part.args !== null) {
    const content = (part.args as Record<string, unknown>).content;
    if (typeof content === 'string') {
      // 末尾换行不算空行：按非空切分后取长度
      const lines = content.length === 0 ? 0 : content.replace(/\n$/u, '').split('\n').length;
      return { path, additions: lines, removed: 0 };
    }
  }
  return { path, additions: 0, removed: 0 };
}

/** 组内改到的全部文件（按归一化路径去重）+ 无路径的修改次数。 */
export function collectChangedFiles(
  parts: readonly SummaryPartLike[],
  indices: readonly number[],
): { files: SummaryChangedFile[]; unresolved: number } {
  const files = new Map<string, SummaryChangedFile>();
  let unresolved = 0;
  for (const index of indices) {
    const part = parts[index];
    if (!part || classifySummaryCategory(part) !== 'change') continue;
    const file = changedFileOf(part);
    if (!file) {
      unresolved++;
      continue;
    }
    const key = normalizeSummaryPath(file.path);
    if (!files.has(key)) files.set(key, file);
  }
  return { files: [...files.values()], unresolved };
}

/** 统计文案（ZCode `formatAssistantSummaryStatistics`，中文 zh-CN 原文）。 */
export function formatSummaryStatistics(
  parts: readonly SummaryPartLike[],
  indices: readonly number[],
  completed = false,
): string {
  let explore = 0;
  let run = 0;
  let unresolved = 0;
  const files = new Set<string>();
  for (const index of indices) {
    const part = parts[index];
    if (!part) continue;
    const category = classifySummaryCategory(part);
    if (category === 'explore') explore++;
    // 统计调用次数，不统计返回的目标数（同一会话的多次操作分别计数）
    if (category === 'run' || category === 'session') run++;
    if (category === 'change' && part.type === 'tool-call') {
      const file = changedFileOf(part);
      if (!file) unresolved++;
      else files.add(normalizeSummaryPath(file.path));
    }
  }
  const completedPrefix = completed ? '已' : '';
  const segments: string[] = [];
  if (explore > 0) segments.push(`${completedPrefix}查阅 ${explore} 项`);
  if (run > 0) segments.push(`${completedPrefix}执行 ${run} 命令`);
  if (files.size > 0) segments.push(`${completedPrefix}修改 ${files.size} 文件`);
  if (unresolved > 0) {
    segments.push(`${completedPrefix}修改 ${unresolved} 次（路径未知）`);
  }
  return segments.join('，') || '思考';
}

/** 代表图标项（ZCode `getAssistantSummaryIconItem` 的优先级）。 */
export function summaryIconIndex(
  parts: readonly SummaryPartLike[],
  indices: readonly number[],
): number | undefined {
  let selected: number | undefined;
  let selectedPriority = Infinity;
  for (const index of indices) {
    const part = parts[index];
    if (!part || part.type !== 'tool-call') continue;
    const category = classifySummaryCategory(part);
    if (!category) continue;
    const toolName = part.toolName ?? '';
    const priority =
      toolName === 'node-repl' || toolName === 'node_repl'
        ? 1
        : category === 'change'
          ? 2
          : category === 'run'
            ? 3
            : 4;
    if (priority < selectedPriority) {
      selected = index;
      selectedPriority = priority;
    }
  }
  return selected;
}

/** 当前活动项（ZCode `getActiveAssistantSummaryItem`）：最后一个流式思考 /
 * 运行中的工具；找不到 = 工具间隙（组头切回统计文本）。 */
export function activeSummaryIndex(
  parts: readonly SummaryPartLike[],
  indices: readonly number[],
): number | undefined {
  for (let i = indices.length - 1; i >= 0; i--) {
    const index = indices[i]!;
    const part = parts[index];
    if (!part) continue;
    if (part.type === 'reasoning' && part.status?.type === 'running') return index;
    if (
      part.type === 'tool-call' &&
      (part.status?.type === 'running' || part.status?.type === 'inputStreaming')
    ) {
      return index;
    }
  }
  return undefined;
}

/**
 * 该连续摘要组是否是「可滚动的 running 组」（ZCode
 * `SummaryGroupBoundaryContext`: `taskRunning && tailRowId === lastRowId`）。
 *
 * 只有整轮尾组能滚动当前项；正文一旦成为整轮尾行，所有组都回到统计数据。
 */
export function isTailSummaryGroup(options: {
  running: boolean;
  /** 组内最后一行在消息 parts 里的下标。 */
  groupLastIndex: number;
  /** 整轮最后一个可见行的下标（正文也参与）。 */
  turnTailIndex: number;
}): boolean {
  return options.running && options.groupLastIndex === options.turnTailIndex;
}

/** 纯 change 组才可折叠展示文件清单（ZCode `getAssistantSummaryChangeFiles`）。 */export function summaryChangeFiles(
  parts: readonly SummaryPartLike[],
  indices: readonly number[],
): { files: SummaryChangedFile[]; unresolved: number } | undefined {
  for (const index of indices) {
    const part = parts[index];
    if (!part) continue;
    const category = classifySummaryCategory(part);
    if (category && category !== 'change') return undefined;
  }
  const { files, unresolved } = collectChangedFiles(parts, indices);
  return files.length ? { files, unresolved } : undefined;
}

/** 单行摘要文案（收起态活动项 / 单行摊平用）：
 * 思考行「思考 持续了几秒」由 Reasoning 组件自己渲染，这里只管工具的
 * 一句摘要：`<类别词> <主文本>`（ZCode 的 kindLabel + primary/secondary）。 */
export function summaryFileLeafName(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/u, '');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}
