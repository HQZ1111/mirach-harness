"use client";

/**
 * 「摘要预览」上下文（ZCode `SummaryPreviewContext`）：
 * 连续摘要组的**收起态组头**滚动展示当前项时，用同一套工具渲染器渲染，
 * 但只取摘要行（图标 + 类别词 + 参数 + 状态），不挂折叠壳、不展开正文、
 * 不写展开记忆。`ToolSummary` 读到 true 时走这条分支。
 */
import { createContext } from "react";

export const SummaryPreviewContext = createContext(false);
