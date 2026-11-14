"use client";

import type { ComponentProps } from "react";
import {
  CheckIcon,
  CopyIcon,
  EllipsisIcon,
  RefreshCwIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TrendingUpDownIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { ghostButton, iconSwap, iconSwapIn, iconSwapOut } from "./surfaces";

export type Reaction = "up" | "down" | null;

export interface MessageActionsProps extends Omit<
  ComponentProps<"div">,
  "children"
> {
  copied: boolean;
  reaction: Reaction;
  regenerating: boolean;
  onCopy: () => void;
  onReactionChange: (reaction: Reaction) => void;
  onRegenerate: () => void;
  onMore: () => void;
  /**
   * 从这条回复分叉（ZCode `chat.message.fork`）。宿主 = 在该轮最后一条
   * user 消息的 fork 点上开新会话；`forkable` 为 false 时按钮禁用（fork
   * 点尚未落盘 / 投影与 pi 路径不一致，不假装可点）。
   */
  onFork?: (() => void) | undefined;
  forkable?: boolean | undefined;
}

export function MessageActions({
  copied,
  reaction,
  regenerating,
  onCopy,
  onReactionChange,
  onRegenerate,
  onMore,
  onFork,
  forkable = true,
  className,
  ...props
}: MessageActionsProps) {
  const buttonClassName = cn(ghostButton, "size-7");

  return (
    <div
      data-slot="message-actions"
      className={cn("flex items-center gap-1", className)}

      {...props}
    >
      <button
        type="button"
        aria-label={copied ? "Copied response" : "Copy response"}
        onClick={onCopy}
        className={cn(
          buttonClassName,
          "grid place-items-center",
          copied && "text-emerald-500",
        )}
      >
        <CopyIcon
          className={cn(
            iconSwap,
            "size-3.5",
            copied ? iconSwapOut : iconSwapIn,
          )}
        />
        <CheckIcon
          className={cn(
            iconSwap,
            "size-3.5",
            copied ? iconSwapIn : iconSwapOut,
          )}
        />
      </button>
      <button
        type="button"
        aria-label="Mark response helpful"
        aria-pressed={reaction === "up"}
        onClick={() => onReactionChange(reaction === "up" ? null : "up")}
        className={cn(
          buttonClassName,
          reaction === "up" &&
            "bg-foreground/[0.06] text-foreground/90 dark:bg-foreground/[0.09]",
        )}
      >
        <ThumbsUpIcon className="size-[var(--size-icon-md)]" />
      </button>
      <button
        type="button"
        aria-label="Mark response unhelpful"
        aria-pressed={reaction === "down"}
        onClick={() => onReactionChange(reaction === "down" ? null : "down")}
        className={cn(
          buttonClassName,
          reaction === "down" &&
            "bg-foreground/[0.06] text-foreground/90 dark:bg-foreground/[0.09]",
        )}
      >
        <ThumbsDownIcon className="size-[var(--size-icon-md)]" />
      </button>
      {onFork ? (
        <button
          type="button"
          aria-label="从这条回复分叉"
          disabled={!forkable}
          onClick={onFork}
          className={cn(buttonClassName, !forkable && "opacity-40")}
        >
          <TrendingUpDownIcon className="size-[var(--size-icon-md)]" />
        </button>
      ) : null}
      <button
        type="button"
        aria-label="Regenerate response"
        onClick={onRegenerate}
        className={buttonClassName}
      >
        <RefreshCwIcon
          className={cn(
            "size-3.5",
            regenerating && "animate-spin motion-reduce:animate-none",
          )}
        />
      </button>
      <button
        type="button"
        aria-label="More response actions"
        onClick={onMore}
        className={buttonClassName}
      >
        <EllipsisIcon className="size-[var(--size-icon-md)]" />
      </button>
    </div>
  );
}
