"use client";

/**
 * 消息级停滞指示（官方 `unstable_useMessageStallDetection` 的接线）。
 *
 * 与 `ThreadThinkingIndicator` 分工：
 * - 后者在 **viewport footer**（thread scope），管"首 token 之前"；
 * - 本组件在 **消息内部**（message scope，官方 hook 硬要求 `s.message.*`），
 *   管"正文/工具已流出、随后内容 2s 不再变化"——工具思考期/provider 卡住。
 *
 * 只在悬停/运行中可见，正文持续变化时自动消失（hook 的 stalled=false）。
 */
import { unstable_useMessageStallDetection } from "@assistant-ui/react";

import { ThinkingIndicator } from "./thinking-indicator";

export function MessageStallIndicator({ label }: { label?: string }) {
  // 官方 hook：必须在使用 message scope 内调用（本组件挂在消息里）。
  const { stalled, stalledForMs } = unstable_useMessageStallDetection({
    thresholdMs: 2000,
  });
  if (!stalled) return null;
  const secs = Math.max(1, Math.round(stalledForMs / 1000));
  return (
    <ThinkingIndicator
      data-slot="aui_message-stall-indicator"
      className="mt-1 text-[13px]"
      label={label ?? "仍在工作"}
      elapsed={`${secs}s`}
    />
  );
}
