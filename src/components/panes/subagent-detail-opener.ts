/**
 * 子代理详情页开启器（2026-11-15）。
 *
 * rpi 的子代理是**进程内 ChildAgent**（`agent_hub` 的 ChildEntry：id(name
 * +序号)、task、status、输出字节数、transcript/steer 路径），不是可切换的
 * 会话；工具结果里的 delegation payload 还可能带 childId/sessionId 与
 * report。因此详情页只展示**真实数据**：任务/角色/状态/轮次/报告/进度，
 * 不伪造子会话入口。
 *
 * 与 preview-opener 同一形态：布局壳（dockview-shell）注册实现，组件层
 * 只投递 payload（解耦不引环）。
 */
export interface SubagentDetailPayload {
  /** 面板标题（缺省「子代理」）。 */
  title?: string;
  name?: string;
  role?: string;
  task?: string;
  status?: string;
  running?: boolean;
  /** 子代理最终报告（delegation payload 的 report）。 */
  report?: string;
  /** 工具输出原文（subagent 工具结果；没有 report 时展示）。 */
  output?: string;
  turns?: number | null;
  maxTurns?: number | null;
  turnLimited?: boolean;
  timeoutSeconds?: number | null;
  /** agent_hub ChildEntry.id（`<agent>-<seq>`）——用于查进度。 */
  childId?: string | null;
  /** delegation payload 的 sessionId；进程内子代理通常不是可切换会话。 */
  sessionId?: string | null;
}

type SubagentDetailOpener = (payload: SubagentDetailPayload) => void

let opener: SubagentDetailOpener | null = null

export function setSubagentDetailOpener(fn: SubagentDetailOpener | null) {
  opener = fn
}

export function openSubagentDetail(payload: SubagentDetailPayload) {
  if (!opener) {
    console.error('[subagent-detail] 详情页通道未注册（布局壳未挂载）', payload)
    return
  }
  opener(payload)
}
