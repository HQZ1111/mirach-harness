"use client";

import type { ComponentProps } from "react";
import { ShuffleIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { floating, ghostButton, mono } from "./surfaces";

export interface RegenerateOption {
  id: string;
  label: string;
  detail: string;
}

export function RegenerateMenu({
  options,
  open,
  currentId,
  onOpenChange,
  onPick,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "options" | "open" | "currentId" | "onOpenChange" | "onPick"
> & {
  options: readonly RegenerateOption[];
  open: boolean;
  currentId: string;
  onOpenChange?: (open: boolean) => void;
  onPick?: (id: string) => void;
}) {
  return (
    <div
      data-slot="regenerate-menu"
      className={cn("flex w-full max-w-sm flex-col gap-2", className)}

      {...props}
    >
      {onOpenChange && (
        <button
          type="button"
          aria-expanded={open}
          aria-label="换模型重新生成"
          title="换模型重新生成"
          onClick={() => onOpenChange(!open)}
          className={cn(
            ghostButton,
            "size-[24px] shrink-0 rounded-[6px] text-foreground hover:text-foreground",
            open && "bg-foreground/[0.06] text-foreground/90",
          )}
        >
          {/* 用 Shuffle 而非 RefreshCw：同一操作条里已有「重新生成」的 ↻，
              两个同图标按钮会被当成重复入口（2026-11-15 用户实报）。 */}
          <ShuffleIcon className="size-[var(--size-icon-md)]" />
        </button>
      )}

      {open && (
        <div
          className={cn(
            floating,
            // 去描边（用户 2026-10-14 全局去描边：浮层不留描边线）——层次由
            // 消费方 wrapper 的 [&>*+*]:shadow-lg 承担（thread.aui.tsx）。
            "fade-in zoom-in-95 slide-in-from-top-1 animate-in flex flex-col gap-0.5 rounded-2xl p-1.5 duration-200",
          )}
        >
          {options.map((option) => {
            const content = (
              <>
                <span className="min-w-0 flex-1 truncate text-[13px]">
                  {option.label}
                </span>
                <span className={cn(mono, "text-foreground/30 shrink-0")}>
                  {option.id === currentId ? "current" : option.detail}
                </span>
              </>
            );
            const className = onPick
              ? "hover:bg-foreground/[0.05] flex items-baseline gap-2 rounded-xl px-2.5 py-1.5 text-start transition-colors"
              : "flex items-baseline gap-2 rounded-xl px-2.5 py-1.5 text-start";

            return onPick ? (
              <button
                key={option.id}
                type="button"
                onClick={() => onPick(option.id)}
                className={className}
              >
                {content}
              </button>
            ) : (
              <div key={option.id} className={className}>
                {content}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
