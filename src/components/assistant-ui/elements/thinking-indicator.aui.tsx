"use client";

/**
 * ThinkingIndicator 连接版（官方文档 elements/thinking-indicator 的接线
 * 模式）：运行中且尚无可见正文时渲染状态行——label 取"仍未返回结果的
 * 工具调用名"，没有则回退 "Thinking"；1s 计时器做耗时徽章（runtime 的
 * timing 元数据只在流结束后定稿）。正文开始流出且无挂起工具 → 不渲染。
 */
import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";

import { ThinkingIndicator } from "./thinking-indicator";

export function ThreadThinkingIndicator() {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  const lastParts = useAuiState((s) => s.thread.messages.at(-1)?.parts);

  const pendingTool = lastParts?.find(
    (p): p is Extract<typeof p, { toolName: string }> =>
      p.type === "tool-call" && !("result" in p && p.result !== undefined),
  );
  const hasVisibleText = lastParts?.some(
    (p) => p.type === "text" && p.text.length > 0,
  );

  const label = pendingTool
    ? `正在使用 ${pendingTool.toolName}`
    : "正在思考";
  const visible = isRunning && !hasVisibleText;

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!visible) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [visible]);

  if (!visible) return null;
  return (
    <ThinkingIndicator
      label={label}
      elapsed={elapsed > 0 ? `${elapsed}s` : undefined}
    />
  );
}
