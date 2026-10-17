/**
 * pi `submit_plan` 的自由文本计划 → 官方 agent-plan 元素的 steps。
 *
 * pi 的 `plan` 参数是**无结构文本**（plan.rs 的 tool description 原文：
 * "The full plan: goal, ordered steps, files to touch, and how to verify"）。
 * 没有 JSON schema 的步骤数组，只能从文本里**提取有序步骤行**。
 *
 * 解析规则（保守，不编造）：
 * 1. 优先认显式编号/符号列表：`1.` `1)` `-` `*` `•`；
 * 2. 其次认 `Steps:` / `步骤:` 段落内的行；
 * 3. 一条都提取不到 → 返回 null（调用方回退通用卡，**不假装有计划**）。
 *
 * 不猜「哪一步正在跑」——pi 没有这个信息；activeIndex 由调用方按"全部未完成"
 * 语义传 0（agent-plan 会把第 0 步显示为进行中），或用 `completed=false` 语义。
 */
export interface ParsedPlan {
  steps: string[]
}

const LIST_MARKER = /^\s*(?:\d{1,2}[.)、]|[-*•])\s+(.+)$/
const STEPS_HEADER = /^\s*(?:steps?|步骤|计划步骤)\s*[:：]\s*$/i

/** 从 `submit_plan` 的 args.plan 文本提取步骤。无可提取 → null。 */
export function parsePlanSteps(plan: unknown): ParsedPlan | null {
  if (typeof plan !== 'string' || plan.trim().length === 0) return null
  const lines = plan.split('\n')
  const steps: string[] = []
  let inStepsBlock = false
  for (const line of lines) {
    if (STEPS_HEADER.test(line)) {
      inStepsBlock = true
      continue
    }
    const m = LIST_MARKER.exec(line)
    if (m) {
      const text = m[1]!.trim()
      if (text.length > 0) steps.push(text)
      continue
    }
    // 非列表行：若在 Steps 段落内且是缩进行，也算一步
    if (inStepsBlock && /^\s{2,}\S/.test(line)) {
      steps.push(line.trim())
      continue
    }
    // Steps 段落遇到空行后的非列表内容 → 段落结束
    if (inStepsBlock && line.trim() === '') inStepsBlock = false
  }
  // 去重（同文本重复列出时保留首次）
  const uniq: string[] = []
  for (const s of steps) if (!uniq.includes(s)) uniq.push(s)
  return uniq.length > 0 ? { steps: uniq } : null
}

/** 计划是否已完成（从 tool 结果 details.planReview 判断；pi 只有
 * pending / auto_approved 两值）。 */
export function planReviewState(result: unknown): 'pending' | 'auto_approved' | null {
  if (typeof result !== 'object' || result === null) return null
  const details = (result as Record<string, unknown>).details
  if (typeof details !== 'object' || details === null) return null
  const r = (details as Record<string, unknown>).planReview
  return r === 'pending' || r === 'auto_approved' ? r : null
}
