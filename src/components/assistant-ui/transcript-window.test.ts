import { describe, expect, it } from "vitest";

import {
  FIRST_PAINT_BUDGET,
  FULL_TRANSCRIPT_BUDGET,
  MIN_VISIBLE_TURNS,
  expandBudget,
  nextBackfillBudget,
  selectTranscriptWindow,
} from "@/components/assistant-ui/transcript-window";
import type { ThreadTurn } from "@/components/assistant-ui/turn-units";

const turn = (key: string): ThreadTurn => ({
  key,
  userId: null,
  messageIds: [key],
});

/** 每条消息充当 `weight` 单位正文：512 字符 = 1 单位。 */
const messageOfWeight = (weight: number) => ({
  parts: [{ type: "text", text: "x".repeat(512 * weight) }],
});

describe("selectTranscriptWindow", () => {
  it("短会话不裁：轮数不足下限时 startTurn=0", () => {
    const turns = Array.from({ length: 3 }, (_, i) => turn(`t${i}`));
    const byId = new Map(turns.map((t) => [t.key, messageOfWeight(1000)]));
    expect(selectTranscriptWindow(turns, byId)).toEqual({
      startTurn: 0,
      windowed: false,
    });
  });

  it("与下限同数不裁：至少保留 minTurns 轮", () => {
    const turns = Array.from({ length: MIN_VISIBLE_TURNS }, (_, i) => turn(`t${i}`));
    const byId = new Map(turns.map((t) => [t.key, messageOfWeight(1000)]));
    const result = selectTranscriptWindow(turns, byId);
    expect(result.startTurn).toBe(0);
    expect(result.windowed).toBe(false);
  });

  it("尾部超预算时裁到尾部，且保留至少下限轮数", () => {
    const turns = Array.from({ length: 40 }, (_, i) => turn(`t${i}`));
    // 每轮 40 单位 → 尾部 15 轮 ≈ 600 单位；下限 8 轮起保
    const byId = new Map(turns.map((t) => [t.key, messageOfWeight(40)]));
    const { startTurn, windowed } = selectTranscriptWindow(turns, byId);
    expect(windowed).toBe(true);
    // 尾部累计到 >= 600 约需 15 轮
    expect(turns.length - startTurn).toBeGreaterThanOrEqual(MIN_VISIBLE_TURNS);
    expect(turns.length - startTurn).toBeLessThanOrEqual(16);
  });

  it("单轮巨重：下限把窗口撑到 minTurns（不会只留一轮）", () => {
    const turns = Array.from({ length: 12 }, (_, i) => turn(`t${i}`));
    const byId = new Map(turns.map((t) => [t.key, messageOfWeight(5000)]));
    const { startTurn } = selectTranscriptWindow(turns, byId);
    expect(turns.length - startTurn).toBe(MIN_VISIBLE_TURNS);
  });

  it("首帧预算优先于整页预算", () => {
    const turns = Array.from({ length: 40 }, (_, i) => turn(`t${i}`));
    const byId = new Map(turns.map((t) => [t.key, messageOfWeight(1)]));
    const first = selectTranscriptWindow(turns, byId, FIRST_PAINT_BUDGET);
    const full = selectTranscriptWindow(turns, byId, FULL_TRANSCRIPT_BUDGET);
    // 每轮 1 单位：首帧 20 轮封顶；整页 40 轮全装（40 < 600）。
    expect(turns.length - first.startTurn).toBe(FIRST_PAINT_BUDGET);
    expect(turns.length - full.startTurn).toBe(40);
    expect(turns.length - full.startTurn).toBeGreaterThan(
      turns.length - first.startTurn,
    );
  });

  it("空转录：不裁也不炸", () => {
    expect(selectTranscriptWindow([], new Map())).toEqual({
      startTurn: 0,
      windowed: false,
    });
  });

  it("纯 todo 消息不计重量（从未挂载）", () => {
    const turns = Array.from({ length: 20 }, (_, i) => turn(`t${i}`));
    const byId = new Map(
      turns.map((t) => [t.key, { parts: [{ type: "tool-call", toolName: "todo", result: {} }] }]),
    );
    expect(selectTranscriptWindow(turns, byId).windowed).toBe(false);
  });
});

describe("预算补齐", () => {
  it("nextBackfillBudget 每次 +48（1-2 个普通轮），到整页预算封顶", () => {
    expect(nextBackfillBudget(FIRST_PAINT_BUDGET)).toBe(68);
    expect(nextBackfillBudget(552)).toBe(FULL_TRANSCRIPT_BUDGET);
    expect(nextBackfillBudget(FULL_TRANSCRIPT_BUDGET)).toBe(
      FULL_TRANSCRIPT_BUDGET,
    );
    expect(nextBackfillBudget(10_000)).toBe(10_000);
  });

  it("expandBudget 一次加一整页", () => {
    expect(expandBudget(FULL_TRANSCRIPT_BUDGET)).toBe(2 * FULL_TRANSCRIPT_BUDGET);
  });
});