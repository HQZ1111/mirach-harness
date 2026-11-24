"use client";

import "@assistant-ui/react-markdown/styles/dot.css";

import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
// 数学公式（2026-10-17 用户批准装依赖）：remark-math 把 $...$ / $$...$$
// 解析成 math 节点，rehype-katex 渲染成 HTML；katex 的样式表必须显式引入
// （否则公式以无排版的裸字符显示——与 dockview CSS 同一类坑）。
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { type FC, memo, useMemo, useRef } from "react";
import type { TextMessagePartProps } from "@assistant-ui/react";

import { SyntaxHighlighter } from "@/components/shiki/syntax-highlighter";
import { STREAM_REVEAL_DEFAULTS } from "@/components/assistant-ui/stream-reveal";
import { cn } from "@/lib/utils";

type MarkdownTextProps = Partial<TextMessagePartProps> & {
  components?: Parameters<typeof memoizeMarkdownComponents>[0];
};

const useShallowStable = <T extends Record<string, unknown> | undefined>(
  value: T,
): T => {
  const ref = useRef(value);
  if (value !== ref.current) {
    const prev = ref.current;
    const stable =
      value !== undefined &&
      prev !== undefined &&
      Object.keys(prev).length === Object.keys(value).length &&
      Object.keys(value).every((key) => prev[key] === value[key]);
    if (!stable) ref.current = value;
  }
  return ref.current;
};

const MarkdownTextImpl: FC<MarkdownTextProps> = ({ components }) => {
  const stableComponents = useShallowStable(components);
  const markdownComponents = useMemo(() => {
    if (!stableComponents) return defaultComponents;
    return {
      ...defaultComponents,
      ...memoizeMarkdownComponents(stableComponents),
    };
  }, [stableComponents]);

  return (
    <MarkdownTextPrimitive
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      className="aui-md text-[length:var(--conversation-text-font-size)] leading-[1.75] [&>*+*]:mt-[16px]"
      components={markdownComponents}
      // 平滑逐字揭示（stream-animate 参数对齐，见 assistant-ui/stream-reveal.ts）：
      // 逐字铺开 + 限制提交频率，避免每个 SSE chunk 一次性贴上来、也避免
      // 每帧重跑 Markdown 解析。prefers-reduced-motion 时框架自动整段直出。
      smooth={STREAM_REVEAL_DEFAULTS}
      defer
    />
  );
};

export const MarkdownText = memo(MarkdownTextImpl);

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => (
    <h1
      className={cn(
        "aui-md-h1 mt-[24px] mb-[16px] scroll-m-20 text-[18px] leading-[28px] font-semibold first:mt-0",
        className,
      )}
      {...props}
    />
  ),
  h2: ({ className, ...props }) => (
    <h2
      className={cn(
        "aui-md-h2 mt-[24px] mb-[16px] scroll-m-20 text-[16px] leading-[28px] font-semibold first:mt-0",
        className,
      )}
      {...props}
    />
  ),
  h3: ({ className, ...props }) => (
    <h3
      className={cn(
        "aui-md-h3 mt-[24px] mb-[16px] scroll-m-20 text-[length:var(--conversation-text-font-size)] leading-[1.75] font-semibold first:mt-0",
        className,
      )}
      {...props}
    />
  ),
  h4: ({ className, ...props }) => (
    <h4
      className={cn(
        "aui-md-h4 mt-[24px] mb-[16px] scroll-m-20 text-[length:var(--conversation-text-font-size)] leading-[1.75] font-semibold first:mt-0",
        className,
      )}
      {...props}
    />
  ),
  h5: ({ className, ...props }) => (
    <h5
      className={cn(
        "aui-md-h5 mt-[24px] mb-[16px] text-[length:var(--conversation-text-font-size)] leading-[1.75] font-medium first:mt-0",
        className,
      )}
      {...props}
    />
  ),
  h6: ({ className, ...props }) => (
    <h6
      className={cn(
        "aui-md-h6 mt-[24px] mb-[16px] text-[length:var(--conversation-text-font-size)] leading-[1.75] font-normal first:mt-0",
        className,
      )}
      {...props}
    />
  ),
  p: ({ className, ...props }) => (
    <p
      className={cn(
        "aui-md-p my-0 mb-[16px] leading-[24.5px] first:mt-0",
        className,
      )}
      {...props}
    />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn(
        "aui-md-a text-primary hover:text-primary/80 underline underline-offset-2",
        className,
      )}
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote
      className={cn(
        "aui-md-blockquote border-muted-foreground/30 text-muted-foreground my-[12px] border-s-2 ps-[16px]",
        className,
      )}
      {...props}
    />
  ),
  ul: ({ className, ...props }) => (
    <ul
      className={cn(
        "aui-md-ul marker:text-muted-foreground my-[12px] list-outside list-disc space-y-[6px] ps-[20px]",
        className,
      )}
      {...props}
    />
  ),
  ol: ({ className, ...props }) => (
    <ol
      className={cn(
        "aui-md-ol marker:text-muted-foreground my-[12px] list-outside list-decimal space-y-[6px] ps-[20px]",
        className,
      )}
      {...props}
    />
  ),
  hr: ({ className, ...props }) => (
    <hr
      className={cn("aui-md-hr border-muted-foreground/20 my-[12px]", className)}
      {...props}
    />
  ),
  table: ({ className, ...props }) => (
    <div className="aui-md-table-wrapper my-[12px] overflow-x-auto">
      <table
        className={cn(
          "aui-md-table w-full border-separate border-spacing-0",
          className,
        )}
        {...props}
      />
    </div>
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "aui-md-th bg-muted px-3 py-1.5 text-start font-medium first:rounded-ss-lg last:rounded-se-lg [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td
      className={cn(
        "aui-md-td border-muted-foreground/20 border-s border-b px-3 py-1.5 text-start last:border-e [[align=center]]:text-center [[align=right]]:text-right",
        className,
      )}
      {...props}
    />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn(
        "aui-md-tr m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-es-lg [&:last-child>td:last-child]:rounded-ee-lg",
        className,
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }) => (
    <li className={cn("aui-md-li ps-[4px] leading-[24.5px] [&>p]:my-0 [&>p]:inline", className)} {...props} />
  ),
  strong: ({ className, ...props }) => (
    <strong
      className={cn("aui-md-strong font-semibold", className)}
      {...props}
    />
  ),
  sup: ({ className, ...props }) => (
    <sup
      className={cn("aui-md-sup [&>a]:text-xs [&>a]:no-underline", className)}
      {...props}
    />
  ),
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        // 围栏外的 pre 兜底（pre 里没有 code 子元素时才走到这）；围栏代码块
        // 由 SyntaxHighlighter（components/shiki/）整卡接管。
        "aui-md-pre bg-muted/30 overflow-x-auto rounded-xl p-3.5 text-[13px] leading-relaxed",
        className,
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={cn(
          !isCodeBlock &&
            "aui-md-inline-code bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.85em]",
          className,
        )}
        {...props}
      />
    );
  },
  // 围栏代码块（shiki 高亮 + 内容键缓存 + 预算 + prose 判定）。
  // 不提供 CodeHeader——管线默认 null，代码卡只有底色无头栏。
  SyntaxHighlighter,
});
