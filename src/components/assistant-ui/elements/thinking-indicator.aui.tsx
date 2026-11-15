"use client";

/**
 * ThinkingIndicator 连接版（官方文档 elements/thinking-indicator 的接线
 * 模式）：运行中且尚无可见正文时渲染状态行——label 取"仍未返回结果的
 * 工具调用名"，没有则回退 "Thinking"；1s 计时器做耗时徽章（runtime 的
 * timing 元数据只在流结束后定稿）。正文开始流出且无挂起工具 → 不渲染。
 */
import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useStore } from "zustand";

import { askBridge } from "@/components/assistant-ui/ask-bridge";
import { approvalBridge } from "@/components/assistant-ui/approval-bridge";
import { formatWorkDuration } from "@/components/assistant-ui/work-segment";
import { ThinkingIndicator } from "./thinking-indicator";

export function ThreadThinkingIndicator() {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  // ZCode `shouldShowTurnChatLoading`：运行中且有交互卡（ask/审批）待处理时
  // 让位给交互卡；否则整轮都显示「工作中 N」——不能只在"还没有正文"时显示，
  // 否则正文一流出计时就消失（用户："工作中几分几秒怎么没有"）。
  const askPending = useStore(askBridge, (s) => s.pending.length);
  const approvalPending = useStore(approvalBridge, (s) => s.pending.length);
  const visible = isRunning && askPending === 0 && approvalPending === 0;

  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!visible) {
      setElapsed(0);
      return;
    }
    setElapsed(0);
    const timer = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [visible]);

  if (!visible) return null;
  return (
    <ThinkingIndicator
      label="工作中"
      elapsed={elapsed > 0 ? formatWorkDuration(elapsed * 1000) : undefined}
    />
  );
}
