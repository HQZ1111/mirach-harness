/**
 * 轮尾文件变更汇总（ZCode `ConversationFileSummaryPanel` 的数据面，
 * 2026-11-03）。纯函数，可单测。
 *
 * ## 数据源（真数据，不编造）
 *
 * 一个 turn 里所有 assistant 消息的 `tool-call` 部件：
 * - `edit` / `hashline_edit`：pi 的 `ToolOutput.details.diff`
 *   （`diff-parse.ts::extractDiffText` 解析）→ additions/deletions 真值；
 * - `write`：pi 的 WriteTool **没有** diff（tools.rs 实锤，整体覆盖）——
 *   文件计数入列，行数记 `null`（UI 不显示该文件的 +/-，**不造 0**）；
 * - 其它工具（read/ls/bash…）不产文件变更，不入列。
 *
 * ## 与 ZCode 的差异
 *
 * ZCode 的 `fileChanges` 由 CLI 在协议层给出聚合值（additions/deletions/
 * files + 明细 patches），并有文件级回滚（rewind）。宿主从工具结果**现场
 * 聚合**——真值同源（都是 pi 工具的真实产出），但没有回滚能力（pi 无
 * file-rewind 面），所以不渲染撤销按钮。
 */
import { diffFilename, diffFromToolResult } from './diff-parse';

/** 写文件类工具（tools.rs 实锤：只有这些改文件）。 */
const FILE_WRITE_TOOLS = new Set(['write', 'edit', 'hashline_edit', 'ast_edit']);

/** 单个文件的变更聚合。`additions/deletions` 为 null = 该工具无 diff 数据。 */
export interface TurnFileChange {
  path: string;
  additions: number | null;
  deletions: number | null;
  /** 产出该变更的工具名（同文件多次编辑会合并） */
  toolNames: string[];
}

/** 聚合输入：tool-call 部件的最小形状（ThreadMessageLike 兼容）。 */
export interface ToolCallPartLike {
  type: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
}

/** 聚合一个 turn 的文件变更（按 path 合并，保持首次出现顺序）。 */
export function summarizeTurnFileChanges(
  parts: readonly ToolCallPartLike[],
): TurnFileChange[] {
  const byPath = new Map<string, TurnFileChange>();
  for (const part of parts) {
    if (part.type !== 'tool-call') continue;
    const toolName = part.toolName ?? '';
    if (!FILE_WRITE_TOOLS.has(toolName)) continue;
    const path = diffFilename(part.args);
    const diff = diffFromToolResult(toolName, part.result);
    const existing = byPath.get(path);
    if (existing) {
      if (!existing.toolNames.includes(toolName)) existing.toolNames.push(toolName);
      // 同文件多次编辑：行数累加（null = 无数据，不参与累加也不清零）
      if (diff) {
        existing.additions = (existing.additions ?? 0) + diff.additions;
        existing.deletions = (existing.deletions ?? 0) + diff.deletions;
      }
    } else {
      byPath.set(path, {
        path,
        additions: diff ? diff.additions : null,
        deletions: diff ? diff.deletions : null,
        toolNames: [toolName],
      });
    }
  }
  return [...byPath.values()];
}

/** 聚合头部数字（ZCode header.fileChanges 同形状）。`null` 行数的文件不计
 * 入 +/-，但计入文件数。全无 diff 数据 → additions/deletions 为 null。 */
export function summarizeFileChangeTotals(changes: readonly TurnFileChange[]): {
  files: number;
  additions: number | null;
  deletions: number | null;
} {
  let additions: number | null = null;
  let deletions: number | null = null;
  for (const c of changes) {
    if (c.additions !== null) additions = (additions ?? 0) + c.additions;
    if (c.deletions !== null) deletions = (deletions ?? 0) + c.deletions;
  }
  return { files: changes.length, additions, deletions };
}
