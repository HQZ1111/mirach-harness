"use client";

/**
 * ThinkingIndicator 连接版（官方文档 elements/thinking-indicator 的接线
 * 模式）：运行中且尚无可见正文时渲染状态行——label 取"仍未返回结果的
 * 工具调用名"，没有则回退 "Thinking"；1s 计时器做耗时徽章（runtime 的
 * timing 元数据只在流结束后定稿）。正文开始流出且无挂起工具 → 不渲染。
 */
import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";

import { formatWorkDuration } from "@/components/assistant-ui/work-segment";
import { ThinkingIndicator } from "./thinking-indicator";

export function ThreadThinkingIndicator() {
  const isRunning = useAuiState((s) => s.thread.isRunning);
  // 运行期间全程显示「工作中 N」。不再用 ask/approval 待处理状态做门：
  // 那两个 store 是**会话级**的，历史里未关闭的卡片会让所有后续 run 的
  // 计时永久消失（实测）。ZCode 的 blockedByInteraction 只针对当前轮的
  // 交互；宿主拿不到"当前轮"归属，宁可与交互卡同屏也不隐藏计时。
  const visible = isRunning;

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
