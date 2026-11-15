/**
 * 工具调用分组（逐字移植 ZCode `lib/exploreToolCall.ts` 的判定语义，
 * 名称→族映射按 pi 的工具表重写）。
 *
 * ZCode 把连续工具调用分成三类父组：
 * - **Explore（查阅）**：只读探查——读文件、搜索、抓网页，以及只读 shell；
 * - **Execute（终端）**：非只读 shell；
 * - **Changes（更改）**：写文件类。
 * 其余工具仍按通用 `group-tool` 聚合。
 *
 * 两条硬语义（来自 `docs/chat/explore-tool-call-stage-status.md` 与
 * `execute-tool-call-grouping.md`）：
 * 1. **至少两个连续同类才成立父组**——单个工具保持原始工具行。这里不靠
 *    groupBy 判长度（它只看得到单个 part），而是渲染层对
 *    `indices.length === 1` 的组直接摊平；
 * 2. **父组状态表达"当前工作阶段"，不是子工具状态汇总**——子工具可能全部
 *    完成，只要后面还没出现可见边界，父组仍是进行中。宿主没有 segment
 *    概念，退化为：组内仍有 running 子工具 = 进行中。
 */
import type { PartState } from "@assistant-ui/react";
import { describeToolCall, toolLabelZh } from "./tool-presentation/tool-presentation";

export type ToolFamily = "explore" | "execute" | "changes" | "other";

/** pi 工具名 → ZCode 的 identity.family（只列分组需要的那几族）。 */
const FILE_READ = new Set(["read", "ls", "image"]);
const SEARCH = new Set(["grep", "find", "ast_grep", "lsp"]);
const WEB_FETCH = new Set(["web_search"]);
const FILE_WRITE = new Set(["write", "edit", "hashline_edit", "ast_edit"]);
// rpi-tools 的壳工具两个：bash.rs / powershell.rs（Windows 上后者承担对象操作）。
// ZCode 的 shell family 同样覆盖多壳——两者都算「终端」组。
const SHELL = new Set(["bash", "powershell"]);

type ShellFamily = "file-read" | "search" | "web-fetch" | "file-write" | "shell" | "other";

function familyOf(toolName: string): ShellFamily {
  if (FILE_READ.has(toolName)) return "file-read";
  if (SEARCH.has(toolName)) return "search";
  if (WEB_FETCH.has(toolName)) return "web-fetch";
  if (FILE_WRITE.has(toolName)) return "file-write";
  if (SHELL.has(toolName)) return "shell";
  return "other";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;/g)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const stripWrappingQuotes = (value: string) => {
    const normalized = value.trim();
    if (
      (normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
      return normalized.slice(1, -1).trim();
    }
    return normalized;
  };
  const shellCommandMatch = trimmed.match(
    /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+([\s\S]+)$/i,
  );
  if (shellCommandMatch?.[1]) {
    return stripWrappingQuotes(shellCommandMatch[1]);
  }

  const powershellCommandMatch = trimmed.match(
    /^(?:powershell(?:\.exe)?|pwsh(?:\.exe)?)\b[\s\S]*?\s-(?:command|c)\s+([\s\S]+)$/i,
  );
  if (powershellCommandMatch?.[1]) {
    return stripWrappingQuotes(powershellCommandMatch[1]);
  }

  return trimmed;
}

function normalizeCommandCandidate(candidate: string): string[] {
  const unwrapped = unwrapShellCommand(candidate);
  if (unwrapped.length === 0) return [];
  return splitCommandSegments(unwrapped);
}

/** 从工具参数里取出全部 shell 命令（pi 的 bash 只有 `command`，其余键照抄上游）。 */
export function extractToolCommands(input: unknown): string[] {
  const commandCandidates: string[] = [];

  const collectFromValue = (value: unknown) => {
    if (typeof value === "string") {
      const command = value.trim();
      if (command.length > 0) commandCandidates.push(command);
      return;
    }

    if (!Array.isArray(value)) return;

    if (value.every((item) => typeof item === "string")) {
      const commandParts = value as string[];
      const shellCommandIndex = commandParts.findIndex((part) => part === "-lc");
      if (
        shellCommandIndex >= 0 &&
        typeof commandParts[shellCommandIndex + 1] === "string"
      ) {
        const shellCommand = commandParts[shellCommandIndex + 1]!.trim();
        if (shellCommand.length > 0) {
          commandCandidates.push(shellCommand);
          return;
        }
      }

      const joinedCommand = commandParts.join(" ").trim();
      if (joinedCommand.length > 0) commandCandidates.push(joinedCommand);
      return;
    }

    for (const item of value) {
      if (!isPlainRecord(item)) continue;
      const parsedCommand = item.cmd;
      if (typeof parsedCommand === "string" && parsedCommand.trim().length > 0) {
        commandCandidates.push(parsedCommand.trim());
      }
    }
  };

  collectFromValue(input);

  if (!isPlainRecord(input)) {
    return Array.from(
      new Set(commandCandidates.flatMap((candidate) => normalizeCommandCandidate(candidate))),
    );
  }

  for (const key of ["command", "cmd", "script", "parsed_cmd"] as const) {
    collectFromValue(input[key]);
  }

  return Array.from(
    new Set(commandCandidates.flatMap((candidate) => normalizeCommandCandidate(candidate))),
  );
}

const EXECUTE_READ_COMMAND_RE =
  /\b(rg|grep|find|ls|cat|head|tail|wc|stat|pwd|which|readlink|tree|sed\s+-n|get-childitem|gci|dir|get-content|gc|type|select-string|sls|get-location|test-path|resolve-path)\b|^git\s+(status|log|show|diff)\b/i;
const EXECUTE_WRITE_COMMAND_RE =
  /\b(sed\s+-i|perl\s+-pi|tee|mv|cp|rm|mkdir|rmdir|touch|truncate|chmod|chown|remove-item|del|erase|set-content|add-content|clear-content|out-file|new-item|move-item|copy-item|rename-item|set-item)\b|^git\s+(add|commit|rm|mv|checkout|switch|restore|reset|clean|revert|cherry-pick|merge|rebase)\b/i;
const SHELL_REDIRECT_WRITE_RE = /(^|[^\d<])>>?\s*\S|&>\s*\S/i;
const SHELL_LOOP_RE = /\b(for|while)\b/i;

/** 只读探查（ZCode `isExploreToolCall`）。 */
export function isExploreToolCall(toolName: string, args: unknown): boolean {
  const family = familyOf(toolName);

  if (family === "file-write") return false;
  if (family === "file-read" || family === "search" || family === "web-fetch") {
    return true;
  }
  if (family !== "shell") return false;

  const commands = extractToolCommands(args);
  if (commands.length === 0) return false;
  if (commands.some((command) => EXECUTE_WRITE_COMMAND_RE.test(command))) return false;
  if (commands.some((command) => SHELL_REDIRECT_WRITE_RE.test(command))) return false;
  if (commands.some((command) => EXECUTE_READ_COMMAND_RE.test(command))) return true;

  // 有些只读探查会包在 for/while 循环里，例如批量查看 README 或递归扫目录，
  // 这种命令本身不一定以 rg/ls 开头，但仍然属于 explore。
  return commands.some(
    (command) => SHELL_LOOP_RE.test(command) && EXECUTE_READ_COMMAND_RE.test(command),
  );
}

/** 非只读 shell（ZCode `isExecuteToolCall`）。 */
export function isExecuteToolCall(toolName: string, args: unknown): boolean {
  if (familyOf(toolName) !== "shell") return false;
  if (extractToolCommands(args).length === 0) return false;
  return !isExploreToolCall(toolName, args);
}

/** 写文件类（ZCode Changes 组）。 */
export function isChangesToolCall(toolName: string): boolean {
  return familyOf(toolName) === "file-write";
}

export function classifyToolFamily(toolName: string, args: unknown): ToolFamily {
  if (isChangesToolCall(toolName)) return "changes";
  if (isExecuteToolCall(toolName, args)) return "execute";
  if (isExploreToolCall(toolName, args)) return "explore";
  return "other";
}

// toolAwareGroupPath / FAMILY_GROUP_KEY / shouldCollapseSingleChildGroup 已删
// （2026-11-07）：它们服务 `MessagePrimitive.GroupedParts` 的相邻合并路径，
// 该渲染路径已被 `assistant-work-items.ts` 的 ZCode 扫描 + `work-parts.aui.tsx`
// 渲染器替换。族分类与父组摘要（本文件其余部分）仍被渲染器直接消费。

/** 文件路径可能落在这几个键上（与 tool-chips 的 chip.path 同源）。 */
export const FILE_CHIP_KEYS = ["path", "file_path", "filePath"] as const;

/** 父组摘要需要的子工具最小投影。 */
export interface FamilyChildTool {
  toolName: string;
  args: unknown;
  /** 部件状态类型（`running` / `complete` / `incomplete` / `requires-action`）。 */
  statusType: string | undefined;
}

export interface FamilySummary {
  /** 滚动队列的内容 key：变化 = 纵向翻滚，不变 = 原位刷新。 */
  key: string;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lastCommandOf(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  const command = args.command ?? args.cmd;
  return typeof command === "string" && command.trim() ? command.trim() : undefined;
}

function latestFileOf(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined;
  for (const key of FILE_CHIP_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * 父组摘要（ZCode `docs/chat/execute-tool-call-grouping.md` Summary Contract）：
 *
 * | 状态 | 查阅 | 终端 | 更改 |
 * |---|---|---|---|
 * | 进行中 | 最新子工具动作 + 目标 | `运行命令 <cmd>` | `N 个文件 · <file>` |
 * | 已完成 | `2 次搜索，1 个文件` | `N 个命令`（+`, M 个失败`） | `N 个文件` |
 *
 * 纯函数（不碰 React），可单测。
 */
export function buildFamilySummary(
  family: Exclude<ToolFamily, "other">,
  tools: readonly FamilyChildTool[],
  running: boolean,
): FamilySummary {
  const last = tools[tools.length - 1];
  const failed = tools.filter((t) => t.statusType === "incomplete").length;

  if (family === "execute") {
    if (running) {
      const command = last ? lastCommandOf(last.args) : undefined;
      return {
        key: `execute:${last?.toolName ?? ""}:${command ?? ""}`,
        text: command ? `运行命令 ${command}` : "运行命令",
      };
    }
    const count = `${tools.length} 个命令`;
    return {
      key: `execute:done:${tools.length}:${failed}`,
      text: failed > 0 ? `${count}，${failed} 个失败` : count,
    };
  }

  if (family === "changes") {
    const files = new Set(
      tools.map((t) => latestFileOf(t.args)).filter((p): p is string => p !== undefined),
    );
    const count = files.size > 0 ? files.size : tools.length;
    if (running) {
      const latest = last ? latestFileOf(last.args) : undefined;
      return {
        key: `changes:${count}:${latest ?? ""}`,
        text: latest ? `${count} 个文件 · ${latest}` : `${count} 个文件`,
      };
    }
    return { key: `changes:done:${count}`, text: `${count} 个文件` };
  }

  // explore
  if (running) {
    const latest = last
      ? describeToolCall({
          name: last.toolName,
          args: last.args,
          status: "running",
        })
      : undefined;
    const label = latest ? toolLabelZh(latest.phrase, true) : "正在查阅";
    return {
      key: `explore:${last?.toolName ?? ""}:${latest?.chip ?? ""}`,
      text: latest?.chip ? `${label} ${latest.chip}` : label,
    };
  }
  const buckets = { search: 0, list: 0, file: 0 };
  for (const t of tools) {
    if (t.toolName === "grep" || t.toolName === "ast_grep" || t.toolName === "lsp") {
      buckets.search += 1;
    } else if (t.toolName === "find") {
      buckets.list += 1;
    } else {
      buckets.file += 1;
    }
  }
  const segments: string[] = [];
  if (buckets.search > 0) segments.push(`${buckets.search} 次搜索`);
  if (buckets.list > 0) segments.push(`${buckets.list} 次列表`);
  if (buckets.file > 0) segments.push(`${buckets.file} 个文件`);
  return {
    key: `explore:done:${buckets.search}:${buckets.list}:${buckets.file}`,
    text: segments.length > 0 ? segments.join("，") : "0 个文件",
  };
}
