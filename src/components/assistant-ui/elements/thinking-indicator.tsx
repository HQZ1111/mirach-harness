"use client";

import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { mono, ShimmerLabel } from "./surfaces";
import { ChatLoadingOrbs } from "./chat-loading-orbs";

/**
 * 运行态指示器：ZCode `ChatLoading` 的宿主版（orbs + 工作中 + 时长）。
 * 2026-11-15 起按真实 ZCode DOM 对齐：orbs size-5、gap-2、标签 14px、
 * 时长 mono 13px/前景弱色。
 */
export function ThinkingIndicator({
  label,
  elapsed,
  className,
  ...props
}: Omit<ComponentProps<"div">, "children" | "label" | "elapsed"> & {
  label: string;
  elapsed?: string;
}) {
  return (
    <div
      data-slot="thinking-indicator"
      className={cn(
        "text-foreground/55 flex w-fit items-center gap-2 text-sm",
        className,
      )}
      {...props}
    >
      <span
        data-chat-loading-icon
        className="flex size-4 shrink-0 items-center justify-center"
      >
        <ChatLoadingOrbs />
      </span>
      <ShimmerLabel
        key={label}
        className="fade-in slide-in-from-bottom-1 animate-in relative inline-block text-[14px] leading-[21px] duration-300"
      >
        {label}
      </ShimmerLabel>
      {elapsed !== undefined && (
        <span
          className={cn(
            mono,
            "text-[13px] leading-[21px] text-foreground/45 tabular-nums",
          )}
        >
          {elapsed}
        </span>
      )}
    </div>
  );
}
