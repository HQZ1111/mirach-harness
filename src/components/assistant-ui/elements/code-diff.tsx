"use client";

import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";
import { codeScroll, codeSurface, mono, paper } from "./surfaces";

export type DiffKind = "context" | "added" | "removed";

export interface DiffLine {
  kind: DiffKind;
  text: string;
}

const GUTTER: Record<DiffKind, string> = {
  context: "",
  added: "+",
  removed: "−",
};

export function CodeDiff({
  filename,
  additions,
  deletions,
  lines,
  cycle,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  "children" | "filename" | "additions" | "deletions" | "lines" | "cycle"
> & {
  filename: string;
  additions: number;
  deletions: number;
  lines: readonly DiffLine[];
  cycle: number;
}) {
  return (
    <div
      data-slot="code-diff"
      className={cn(
        paper,
        // 2026-11-27 用户：「现在对话中显示的代码修改，Reviewable diff 等高亮的
        // 卡片组件不舒服，和 ass 的不太一样」。对齐 ass 官方 code-diff：
        //   · 宽度不再卡 max-w-md（512px）——长行在窄卡里被挤成横滚条；
        //     改成与消息正文同宽（max-w-none + w-full）；
        //   · 圆角 2xl → xl（与官方卡片一致，不再“胶囊感”）；
        //   · 去掉逐行 animationDelay 递增（长 diff 会逐行闪现，观感跳）。
        "w-full max-w-none overflow-hidden rounded-xl font-mono text-xs",
        className,
      )}

      {...props}
    >
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <span className="text-foreground/90">{filename}</span>
        <span className={cn(mono, "tabular-nums")}>
          <span className="text-emerald-600 dark:text-emerald-400">
            +{additions}
          </span>{" "}
          <span className="text-red-600 dark:text-red-400">−{deletions}</span>
        </span>
      </div>
      <div className={codeScroll}>
        <div className={codeSurface}>
          {lines.map((line, i) => (
            <div
              key={`${cycle}-${i}-${line.text}`}
              className={cn(
                "flex px-4 py-0.5 leading-relaxed whitespace-pre",
                line.kind === "context" && "text-foreground/45",
                line.kind === "added" &&
                  "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
                line.kind === "removed" &&
                  "bg-red-500/10 text-red-700 dark:text-red-300",
              )}
            >
              <span className="w-4 shrink-0 select-none">
                {GUTTER[line.kind]}
              </span>
              <span>{line.text}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
