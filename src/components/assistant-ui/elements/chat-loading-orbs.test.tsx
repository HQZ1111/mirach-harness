import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  ChatLoadingOrbs,
  ORB_M_PATH,
  ORB_POINT_COUNT,
  sampleOrbLine,
} from "./chat-loading-orbs";

type Point = readonly [number, number];

const points = sampleOrbLine(ORB_M_PATH, ORB_POINT_COUNT);

/**
 * 把点投影到 M 折线上，返回最近距离与沿路径的累计弧长。
 * 用于同时验证「点都在笔画上」和「按弧长均匀分布」。
 */
function projectOnPath(point: Point) {
  let best = { distance: Number.POSITIVE_INFINITY, along: 0 };
  let consumed = 0;
  for (let index = 1; index < ORB_M_PATH.length; index += 1) {
    const [x0, y0] = ORB_M_PATH[index - 1];
    const [x1, y1] = ORB_M_PATH[index];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const length = Math.hypot(dx, dy);
    const t = Math.max(
      0,
      Math.min(
        1,
        ((point[0] - x0) * dx + (point[1] - y0) * dy) / (length * length),
      ),
    );
    const distance = Math.hypot(
      point[0] - (x0 + dx * t),
      point[1] - (y0 + dy * t),
    );
    if (distance < best.distance) {
      best = { distance, along: consumed + length * t };
    }
    consumed += length;
  }
  return best;
}

describe("ChatLoadingOrbs M glyph", () => {
  it("samples exactly 105 points inside the Z canvas box (x 3..17, y 4..16)", () => {
    expect(points).toHaveLength(ORB_POINT_COUNT);

    const pathXs = ORB_M_PATH.map(([x]) => x);
    const pathYs = ORB_M_PATH.map(([, y]) => y);
    expect(Math.min(...pathXs)).toBe(3);
    expect(Math.max(...pathXs)).toBe(17);
    expect(Math.min(...pathYs)).toBe(4);
    expect(Math.max(...pathYs)).toBe(16);

    const xs = points.map(([x]) => x);
    const ys = points.map(([, y]) => y);
    expect(Math.min(...xs)).toBeCloseTo(3);
    expect(Math.max(...xs)).toBeCloseTo(17);
    expect(Math.max(...ys)).toBeCloseTo(16);
    // 采样点避免重复端点，顶部端点在最近的两个采样点之间（弧长采样下 ≈0.05）。
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(4);
    expect(Math.min(...ys)).toBeLessThan(4.1);
  });

  it("keeps every point on the M strokes and spaces them evenly by arc length", () => {
    const total = ORB_M_PATH.slice(1).reduce(
      (sum, [x, y], index) =>
        sum +
        Math.hypot(x - ORB_M_PATH[index][0], y - ORB_M_PATH[index][1]),
      0,
    );
    const step = total / (ORB_POINT_COUNT - 1);

    points.forEach((point, index) => {
      const projected = projectOnPath(point);
      expect(projected.distance).toBeLessThan(1e-9);
      expect(projected.along).toBeCloseTo(index * step, 9);
    });
  });

  it("has both full-height verticals, a bottom-centre apex and no Z top bar", () => {
    // 中下顶点在弧长 50% 处，采样点精确落在 (10, 16)。
    expect(
      points.some(
        ([x, y]) => Math.abs(x - 10) < 1e-9 && Math.abs(y - 16) < 1e-9,
      ),
    ).toBe(true);

    // 左竖、右竖都跨越整字高（4..16）。
    const leftStem = points.filter(([x]) => Math.abs(x - 3) < 1e-9);
    const rightStem = points.filter(([x]) => Math.abs(x - 17) < 1e-9);
    expect(Math.max(...leftStem.map(([, y]) => y))).toBeGreaterThan(15.8);
    expect(Math.min(...leftStem.map(([, y]) => y))).toBeLessThan(4.2);
    expect(Math.max(...rightStem.map(([, y]) => y))).toBeGreaterThan(15.8);
    expect(Math.min(...rightStem.map(([, y]) => y))).toBeLessThan(4.2);

    // 顶部窄带只允许两个竖笔的顶端；Z 的顶横会在中段留下 y≈4 的点。
    const topBand = points.filter(([, y]) => y < 4.5);
    expect(topBand.length).toBeGreaterThan(0);
    expect(topBand.every(([x]) => x <= 3.5 || x >= 16.5)).toBe(true);
  });

  it("uses the theme brand token for the orb fill", () => {
    const markup = renderToStaticMarkup(createElement(ChatLoadingOrbs, {}));
    expect(markup).toContain("text-[var(--brand)]");
    expect(markup).toContain('fill="currentColor"');
  });
});
