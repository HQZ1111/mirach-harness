"use client";

/**
 * 工具调用分流：pi 工具部件 → ZCode 式摘要行 + 按需展开正文
 * （ZCode `ToolCallBlocks/resolveRenderer.ts` + `renderers/*.tsx` 的宿主口径，
 * 2026-11-15）。
 *
 * ## 分流顺序（对照 ZCode resolveToolCallRenderer）
 *
 * 1. 子代理委托结果（rpi-subagents 的 `delegate_task`）→ 专用卡；
 * 2. `subagent` → 子代理行（ZCode agent.tsx 单行形态）；
 * 3. 工具目录查询 → 搜索行；`submit_plan` → 计划卡（不用摘要行，ZCode 的
 *    plan-guidance 也是独立卡）；
 * 4. **todo 工具默认不渲染**（ZCode `showTodoToolCalls` 默认 false：待办在状态
 *    面板有专区分区，消息流里重复一条是噪声）；「行为与工具 → 显示待办」打开
 *    后走普通摘要行进流（ZCode 同款开关，conversation-display-store）；
 * 5. 按工具名分派：bash（终端）/ read|ls（读取）/ grep|find|ast_grep|lsp
 *    （搜索）/ edit|hashline_edit|ast_edit|write（更改）/ web_search（搜索卡）；
 * 6. 其余按 presentation 兜底（图标 + 中文动词 + 目标 chip + 参数/结果）。
 *
 * 失败不换卡：状态词「执行失败」红显 + 虚线下划线 tooltip（错误原文可复制），
 * 正文照常展开（ZCode `showFailureStatus` 同款）。
 */
import {
  type ToolCallMessagePartComponent,
  type ToolCallMessagePartProps,
} from "@assistant-ui/react";
import {
  CircleHelpIcon,
  FilePenIcon,
  FilePlusIcon,
  FileTextIcon,
  FolderOpenIcon,
  GlobeIcon,
  ListChecksIcon,
  SearchIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { type ReactNode } from "react";
import { AgentPlan } from "@/components/assistant-ui/elements/agent-plan";
import { CodeDiff } from "@/components/assistant-ui/elements/code-diff";
import { DelegationCard, parseDelegationResult } from "@/components/assistant-ui/elements/delegation-card";
import { SubagentLine } from "@/components/assistant-ui/elements/subagent-line";
import {
  ToolBody,
  ToolDiffStat,
  ToolSummary,
} from "@/components/assistant-ui/elements/tool-summary.aui";
import {
  diffFilename,
  diffFromToolResult,
} from "@/components/assistant-ui/diff-parse";
import {
  changedFileOf,
  summaryFileLeafName,
} from "@/components/assistant-ui/work-summary";
import { parsePlanSteps, planReviewState } from "@/components/assistant-ui/plan-parse";
import { openFileFromToolPath } from "@/components/assistant-ui/open-file";
import { useConversationDisplay } from "@/components/assistant-ui/conversation-display-store";
import {
  describeToolCall,
  toolLabelZh,
} from "@/components/assistant-ui/tool-presentation/tool-presentation";

// ── 形状工具（纯函数，原 thread.aui 内联版迁移）────────────────────────

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** pi `ToolOutput` 的序列化形状（tools.rs:303，camelCase）。流式
 * （agui.rs 原样透传）与水合（pi-hydrate 同形构造）共用。 */
const isToolOutputLike = (
  result: unknown,
): result is { content: unknown[]; details?: unknown; isError?: boolean } =>
  isPlainRecord(result) && Array.isArray(result.content);

/** 工具结果文本化：ToolOutput 对象拼 content 文本、string 原样、其余 JSON。 */
export const toolResultText = (result: unknown): string => {
  if (typeof result === "string") return result;
  if (result === undefined || result === null) return "";
  if (isToolOutputLike(result)) {
    return result.content
      .map((b) =>
        typeof b === "string"
          ? b
          : typeof (b as { text?: unknown })?.text === "string"
            ? (b as { text: string }).text
            : "",
      )
      .join("");
  }
  try {
    return JSON.stringify(result, null, 2) ?? String(result);
  } catch {
    return String(result);
  }
};

/** 类别词（ZCode 各 renderer 的 kindLabel，中文与上游 zh-CN 逐一对照）。 */
const KIND_LABELS: Record<string, { running: string; done: string }> = {
  // rpi-tools 的壳工具两个（bash.rs / powershell.rs，Windows 上 powershell
  // 承担对象操作，两者都是「命令 + 输出」的终端行）
  bash: { running: "正在执行", done: "已执行" },
  powershell: { running: "正在执行", done: "已执行" },
  read: { running: "正在读取", done: "已读取" },
  image: { running: "正在读取", done: "已读取" },
  ls: { running: "正在读取", done: "已读取" },
  grep: { running: "正在搜索", done: "已搜索" },
  find: { running: "正在搜索", done: "已搜索" },
  ast_grep: { running: "正在搜索", done: "已搜索" },
  lsp: { running: "正在搜索", done: "已搜索" },
  web_search: { running: "正在搜索", done: "已搜索" },
  // rpi 的网页搜索扩展工具名（无下划线；见 tool-specs.ts:202 实测注释）
  websearch: { running: "正在搜索", done: "已搜索" },
  edit: { running: "正在编辑", done: "已编辑" },
  hashline_edit: { running: "正在编辑", done: "已编辑" },
  ast_edit: { running: "正在编辑", done: "已编辑" },
  write: { running: "正在写入", done: "已写入" },
};

const stringArg = (args: unknown, ...keys: string[]): string | undefined => {
  if (!isPlainRecord(args)) return undefined;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
};

// ── 正文块 ──────────────────────────────────────────────────────────

const CommandLine: React.FC<{ command: string }> = ({ command }) => (
  <div className="bg-muted/40 rounded-lg px-2.5 py-1.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap">
    <span className="text-muted-foreground/60 select-none">$ </span>
    {command}
  </div>
);

const OutputBlock: React.FC<{ text: string; running: boolean }> = ({
  text,
  running,
}) => {
  if (text.length === 0) {
    if (running) {
      return (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <span className="bg-muted-foreground/60 size-1.5 animate-pulse rounded-full" />
          等待输出…
        </p>
      );
    }
    return <p className="text-muted-foreground text-xs">没有输出。</p>;
  }
  return (
    <pre
      data-slot="aui_tool-output"
      data-running={running ? "1" : "0"}
      className="text-foreground/80 max-h-72 overflow-auto font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
    >
      {text}
    </pre>
  );
};

/** 参数表（ZCode fallback 的 ParameterValue：扁平对象用两列 dl）。 */
const ParamsBlock: React.FC<{ args: unknown }> = ({ args }) => {
  if (args === undefined) return null;
  const entries = isPlainRecord(args) ? Object.entries(args) : null;
  if (entries !== null && entries.length === 0) return null;
  if (
    entries !== null &&
    entries.every(([, value]) => value === null || typeof value !== "object")
  ) {
    return (
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-3 gap-y-1 text-xs">
        {entries.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="text-muted-foreground min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {key}
            </dt>
            <dd className="min-w-0 font-mono whitespace-pre-wrap [overflow-wrap:anywhere]">
              {typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <pre className="text-foreground/80 max-h-60 overflow-auto font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">
      {JSON.stringify(args, null, 2)}
    </pre>
  );
};

const ResultBlock: React.FC<{ result: unknown; failed: boolean }> = ({
  result,
  failed,
}) => {
  const text = toolResultText(result);
  if (text.length === 0) return null;
  return (
    <pre
      data-slot="aui_tool-result"
      className={
        failed
          ? "max-h-60 overflow-auto font-mono text-xs whitespace-pre-wrap text-red-600 dark:text-red-400"
          : "text-foreground/80 max-h-60 overflow-auto font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]"
      }
    >
      {text}
    </pre>
  );
};

// ── 通用摘要行 ──────────────────────────────────────────────────────

interface RowModel {
  toolId: string;
  running: boolean;
  failed: boolean;
  statusLabel: string | undefined;
  errorText: string | undefined;
}

const buildRowModel = (
  part: ToolCallMessagePartProps,
): RowModel => {
  const statusType = part.status?.type;
  const failed = part.isError === true || statusType === "incomplete";
  const errorText = failed ? toolResultText(part.result) || undefined : undefined;
  // 状态词只在「失败 / 等待审批」出现——ZCode 的 `showStatusLabel` 默认 false：
  // 成功态由类别词的时态表达（已执行），运行态由类别词扫光表达；再挂一个
  // 状态词（或秒数）就是同一句话说两遍。
  const statusLabel = failed
    ? "执行失败"
    : statusType === "requires-action"
      ? "等待中"
      : undefined;
  return {
    toolId: part.toolCallId,
    running: statusType === "running",
    failed,
    statusLabel,
    errorText,
  };
};

/** 计划卡（ZCode plan-guidance 独立卡）：步骤来自 pi 的自由文本计划。 */
const PlanCard: React.FC<{
  steps: readonly string[];
  result: unknown;
}> = ({ steps, result }) => {
  // pi 没有「第几步在跑」的信息：未审完 → 全部待办（activeIndex 0 会让首步
  // 显示为进行中，语义不符）；审完 → 全部完成。
  const activeIndex = planReviewState(result) === "auto_approved" ? steps.length : 0;
  return (
    <AgentPlan
      steps={steps}
      activeIndex={activeIndex}
      data-slot="aui-submit-plan"
      className="max-w-none"
    />
  );
};

/** ask_user 结果 → 问答对（rpi-ask-user details.answers：{id, question,
 *  values, text, confirmed}；values = 选项标题数组，text = 自由输入）。 */
export function parseAskAnswers(
  result: unknown,
): { question: string | null; answer: string | null }[] {
  if (!isPlainRecord(result)) return [];
  const details = result.details;
  if (!isPlainRecord(details)) return [];
  const answers = details.answers;
  if (!Array.isArray(answers)) return [];
  return answers.flatMap((raw) => {
    if (!isPlainRecord(raw)) return [];
    const question = typeof raw.question === "string" ? raw.question : null;
    const values = Array.isArray(raw.values)
      ? raw.values.filter((v): v is string => typeof v === "string")
      : [];
    const text = typeof raw.text === "string" && raw.text !== "" ? raw.text : null;
    const answer = values.length > 0 ? values.join("、") : text;
    return [{ question, answer }];
  });
}

// ── 分流 ────────────────────────────────────────────────────────────

export const PiToolUI: ToolCallMessagePartComponent = (part) => {
  const { toolName, args, result, status } = part;
  const running = status?.type === "running";
  const row = buildRowModel(part);
  // 「行为与工具 → 显示待办」：false（默认，ZCode 同款）时 todo 行不进消息流。
  const showTodos = useConversationDisplay((s) => s.showTodos);

  // 1. 子代理委托结果（结果里带 rpi-delegation JSON）→ 专用卡
  const delegation = parseDelegationResult(result);
  if (delegation !== null) {
    return <DelegationCard result={delegation} running={running} />;
  }

  // 2. subagent 工具 → 子代理行
  if (toolName === "subagent") {
    return (
      <SubagentLine
        args={isPlainRecord(args) ? args : undefined}
        result={result}
        isError={row.failed}
        running={running}
        toolId={row.toolId}
      />
    );
  }

  // 3. submit_plan → 计划卡（步骤解析失败落回摘要行）
  if (toolName === "submit_plan") {
    const plan = stringArg(args, "plan");
    const parsed = parsePlanSteps(plan);
    if (parsed !== null) {
      return <PlanCard steps={parsed.steps} result={result} />;
    }
  }

  // 4. todo 工具默认不在消息流渲染（状态面板有待办分区；「显示待办」打开
  //    时落到下方普通摘要行）
  if (toolName === "todo" && !showTodos) return null;

  const kind = KIND_LABELS[toolName];
  const pres = describeToolCall({
    name: toolName,
    args,
    status: running ? "running" : "success",
  });
  const kindLabel = kind ? (running ? kind.running : kind.done) : toolLabelZh(pres.phrase, running);

  const summary = (opts: {
    icon: ReactNode;
    kindLabelOverride?: string;
    primaryText?: ReactNode;
    secondaryText?: ReactNode;
    hideSecondaryWhenOpen?: boolean;
    diffCount?: ReactNode;
    canToggle: boolean;
    content?: ReactNode;
  }) => (
    <ToolSummary
      toolId={row.toolId}
      toolName={toolName}
      icon={opts.icon}
      kindLabel={opts.kindLabelOverride ?? kindLabel}
      primaryText={opts.primaryText}
      secondaryText={opts.secondaryText}
      hideSecondaryWhenOpen={opts.hideSecondaryWhenOpen}
      diffCount={opts.diffCount}
      statusLabel={row.statusLabel}
      failed={row.failed}
      statusTooltip={row.errorText}
      running={row.running}
      canToggle={opts.canToggle}
      title={pres.label}
      content={opts.content}
    />
  );

  // 5a. bash / powershell → 终端行（ZCode ExecuteToolCallBlock）
  // 摘要 = `已执行 <description ?? command>`：ZCode execute.tsx:274-278 只对
  // **Bash** 读 `input.description`（调用意图），其余命令工具直接显示命令行。
  // rpi 的 bash（bash.rs:49）同样有 `description` 参数（"shown to the user
  // in the collapsed tool row"），模型实测在传（2026-11-19 会话 35 条）——
  // 原样显示，语言不过滤（用户 2026-11-19 定稿：与 ZCode 完全对齐，取代
  // 11-15 的中文偏好过滤）。展开后仍保留描述（ZCode
  // hideSecondaryTextWhenOpen={!description}）；没有描述时命令行在展开态
  // 隐藏（正文里有完整命令，避免与摘要重复）。powershell 摘要按 ZCode 口径
  // 恒用原始 command。
  if (toolName === "bash" || toolName === "powershell") {
    const description = stringArg(args, "description");
    const command = stringArg(args, "command", "cmd", "script");
    const summaryText = (toolName === "bash" ? description : undefined) ?? command;
    if (summaryText !== undefined) {
      const text = toolResultText(result);
      return summary({
        icon: <SquareTerminalIcon />,
        secondaryText: (
          <code className="truncate font-sans text-muted-foreground/70">{summaryText}</code>
        ),
        hideSecondaryWhenOpen: toolName !== "bash" || description === undefined,
        canToggle: true,
        content: (
          <ToolBody>
            {command !== undefined ? <CommandLine command={command} /> : null}
            <OutputBlock text={text} running={running} />
          </ToolBody>
        ),
      });
    }
  }

  // 5a2. ask_user → 询问行（ZCode AskUserQuestion 卡）：摘要 = `已询问 N 个问题`，
  // 展开 = 左侧竖线内的 Q（medium）/ A（subtle）对。失败无 answers 时回退展示
  // 问题参数 + 错误（不编造答案）。
  if (["ask_user", "AskUserQuestion", "ask_question"].includes(toolName)) {
    const answers = parseAskAnswers(result);
    const questionFallback = stringArg(args, "question", "prompt");
    const batch = isPlainRecord(args) && Array.isArray(args.questions) ? args.questions.length : 0;
    const count = answers.length > 0 ? answers.length : batch > 0 ? batch : 1;
    return summary({
      icon: <CircleHelpIcon />,
      kindLabelOverride: running ? "正在询问" : "已询问",
      primaryText: `${count} 个问题`,
      // ZCode ask-question.tsx: `canToggle={!isRunning}`——运行中不可展开
      // （答案还没产生，展开只会露出"参数缺失"占位）。
      canToggle: !running,
      content: running ? undefined : (
        <div className="border-border ml-2 space-y-2 border-l pl-3.5">
          {answers.length > 0 ? (
            answers.map((entry, index) => (
              <div key={index} className="space-y-1">
                {entry.question !== null ? (
                  <p className="text-foreground text-[14px] leading-5 font-medium">
                    {entry.question}
                  </p>
                ) : null}
                {entry.answer !== null ? (
                  <p className="text-muted-foreground text-[14px] leading-5">
                    {entry.answer}
                  </p>
                ) : null}
              </div>
            ))
          ) : (
            <div className="space-y-1">
              <p className="text-foreground text-[14px] leading-5 font-medium">
                {questionFallback ?? "（问题参数缺失）"}
              </p>
              {row.failed ? (
                <p className="text-muted-foreground text-[14px] leading-5">
                  {row.errorText ?? "执行失败"}
                </p>
              ) : null}
            </div>
          )}
        </div>
      ),
    });
  }

  // 5b. read / ls / image → 只读行（ZCode read.tsx：kind 已读取、放大镜图标、
  // primary = **文件名**（完整路径只进 tooltip），不可展开；右键/侧栏看正文）。
  if (toolName === "read" || toolName === "ls" || toolName === "image") {
    const path = stringArg(args, "path", "file_path", "filePath");
    const chip = path ? (
      <>
        {toolName === "ls" ? (
          <FolderOpenIcon className="size-4 shrink-0" />
        ) : toolName === "read" ? (
          <SearchIcon className="size-4 shrink-0" />
        ) : (
          <FileTextIcon className="size-4 shrink-0" />
        )}
        <span className="min-w-0 truncate">{summaryFileLeafName(path)}</span>
      </>
    ) : null;
    return summary({
      icon:
        toolName === "ls" ? (
          <FolderOpenIcon />
        ) : toolName === "read" ? (
          <SearchIcon />
        ) : (
          <FileTextIcon />
        ),
      primaryText:
        path === undefined ? undefined : toolName === "ls" ? (
          <span
            className="inline-flex min-w-0 max-w-full items-center gap-1.5"
            title={path}
          >
            {chip}
          </span>
        ) : (
          <button
            type="button"
            data-slot="aui_file-chip"
            title={path}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              openFileFromToolPath(path);
            }}
            className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-left transition-colors hover:text-foreground"
          >
            {chip}
          </button>
        ),
      canToggle: false,
    });
  }

  // 5c. grep / find / ast_grep / lsp → 搜索行（不可展开，摘要即全部）
  if (["grep", "find", "ast_grep", "lsp"].includes(toolName)) {
    const query = stringArg(args, "pattern", "query", "glob", "symbol");
    return summary({
      icon: <SearchIcon />,
      primaryText: query,
      canToggle: false,
    });
  }

  // 5d. 写文件类 → 更改行（ZCode EditToolCallBlock）：文件 chip + diff 计数；
  // 正文 = details.diff（edit 系 + 2026-11-15 后的 write），旧引擎的 write
  // 没有 diff 时回退参数/结果
  if (["edit", "hashline_edit", "ast_edit", "write"].includes(toolName)) {
    const path = stringArg(args, "path", "file_path", "filePath");
    const diff = diffFromToolResult(toolName, result);
    // 行数：优先 details.diff（真实增删）；旧引擎 write 无 diff 时按写入
    // 内容行数计新增（数据来源与口径见 work-summary.ts::changedFileOf）
    const file = changedFileOf({ type: "tool-call", toolName, args, result });
    const additions = diff?.additions ?? file?.additions ?? 0;
    const removals = diff?.deletions ?? file?.removed ?? 0;
    return summary({
      icon: toolName === "write" ? <FilePlusIcon /> : <FilePenIcon />,
      primaryText: path ? (
        <button
          type="button"
          data-slot="aui_file-chip"
          title={path}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openFileFromToolPath(path);
          }}
          className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 text-left transition-colors hover:text-foreground"
        >
          {toolName === "write" ? (
            <FilePlusIcon className="size-4 shrink-0" />
          ) : (
            <FilePenIcon className="size-4 shrink-0" />
          )}
          <span className="min-w-0 truncate">{summaryFileLeafName(path)}</span>
        </button>
      ) : undefined,
      diffCount:
        additions === 0 && removals === 0 ? undefined : (
          <ToolDiffStat added={additions} removed={removals} />
        ),
      canToggle: true,
      content: (
        <ToolBody>
          {diff !== null ? (
            <CodeDiff
              filename={diffFilename(args)}
              additions={diff.additions}
              deletions={diff.deletions}
              lines={diff.lines}
              cycle={0}
              className="max-w-none"
            />
          ) : (
            <>
              <ParamsBlock args={args} />
              <ResultBlock result={result} failed={row.failed} />
            </>
          )}
        </ToolBody>
      ),
    });
  }

  // 5e. 网页搜索（web_search / websearch）→ ZCode `SearchToolCallBlock`：
  // 单行「已搜索 <query>」（运行中「正在搜索」），**不可展开**——ZCode 不在
  // 消息里铺结果卡（结果由模型消费）。旧宿主版 WebSearch 卡要求 JSON 结果，
  // 而 rpi 的 websearch 返回纯文本（"Found 8 web reference(s)…"），解析失败
  // 时退化成参数/结果原文 JSON——用户报的「网页搜索显示没打通」即此。
  if (toolName === "web_search" || toolName === "websearch") {
    const query =
      stringArg(args, "query", "q", "search_query", "searchQuery", "pattern") ?? "";
    return summary({
      icon: <SearchIcon />,
      // ZCode search.tsx:22/82：主文本是完整句「查找 {query}」，不是裸 query
      // （kind 词仍是 正在搜索/已搜索）。
      primaryText: query ? `查找 ${query}` : undefined,
      canToggle: false,
    });
  }

  // 5e-2. 网页抓取（webfetch / web_fetch / fetch）→ ZCode
  // `WebFetchToolCallBlock`：单行「网页抓取 <url>」（运行中「正在抓取」），
  // primaryText 必须是 URL——prompt 不能替代目标地址（ZCode 注释原话）。
  if (["webfetch", "web_fetch", "fetch"].includes(toolName)) {
    const url = stringArg(args, "url") ?? "";
    return summary({
      icon: <GlobeIcon />,
      kindLabelOverride: running ? "正在抓取" : "网页抓取",
      primaryText: url || undefined,
      canToggle: false,
    });
  }

  // 5f. 工具目录查询（ToolSearch/LocalToolSearch：query 为 `select:a,b` 形式）
  if (toolName === "ToolSearch" || toolName === "LocalToolSearch") {
    const query = stringArg(args, "query") ?? "";
    const selection = /^select:(.+)$/i.exec(query);
    const label = selection
      ? selection[1]!
          .split(",")
          .map((name) => name.trim())
          .filter(Boolean)
          .join(", ")
      : query;
    return summary({
      icon: <ListChecksIcon />,
      primaryText: label || undefined,
      canToggle: false,
    });
  }

  // 6. 兜底：presentation 动词 + 目标 chip + 参数/结果（ZCode FallbackToolCallBlock）
  const PresIcon = pres.icon;
  return summary({
    icon: <PresIcon />,
    primaryText: pres.chip,
    canToggle: args !== undefined || result !== undefined,
    content: (
      <ToolBody>
        <ParamsBlock args={args} />
        <ResultBlock result={result} failed={row.failed} />
        {args === undefined && result === undefined ? (
          <p className="text-muted-foreground text-xs">
            {running ? "等待结果" : "暂无结果"}
          </p>
        ) : null}
      </ToolBody>
    ),
  });
};
