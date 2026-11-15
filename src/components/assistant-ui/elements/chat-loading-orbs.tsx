"use client";

/**
 * ZCode `ChatLoadingOrbs` 的逐字移植（packages/ui/src/components/
 * ai-elements/chat-loading.tsx:14-165）。
 *
 * 运行态指示器的球面点阵：105 个点按 Fibonacci 球面分布，每 8240ms 做一次
 * 球体 ↔ 字形（Z）morph；`prefers-reduced-motion` 时静态停在字形点。
 * 只依赖 rAF/geometry，不引入 ZCode 的 i18n 与图标。
 */
import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

// 球面密度独立于 Z 点阵，避免调整字形间距时意外改变球体；动画几何只生成一次。
const ORB_Z_POINTS = [
  [3, 4],
  [5, 4],
  [7, 4],
  [9, 4],
  [13, 4],
  [15, 4],
  [17, 4],
  [11, 6],
  [13, 6],
  [15, 6],
  [9, 8],
  [11, 8],
  [13, 8],
  [9, 10],
  [11, 10],
  [7, 12],
  [9, 12],
  [11, 12],
  [5, 14],
  [7, 14],
  [9, 14],
  [3, 16],
  [5, 16],
  [7, 16],
  [11, 16],
  [13, 16],
  [15, 16],
  [17, 16],
] as const;
const ORB_POINT_COUNT = 105;
const ORB_Z_TARGETS = new Map<number, readonly [number, number]>(
  ORB_Z_POINTS.map((point, index) => [
    Math.floor((index * ORB_POINT_COUNT) / ORB_Z_POINTS.length),
    point,
  ]),
);
const ORB_SPHERE = Array.from({ length: ORB_POINT_COUNT }, (_, index) => {
  const y = 1 - (index / (ORB_POINT_COUNT - 1)) * 2;
  const radius = Math.sqrt(Math.max(0, 1 - y * y));
  const theta = Math.PI * (3 - Math.sqrt(5)) * index;
  return [Math.cos(theta) * radius, y, Math.sin(theta) * radius] as const;
});
const easeOrbMorph = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

export function ChatLoadingOrbs({ className }: { className?: string }) {
  const groupRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const dots = Array.from(group.querySelectorAll("circle"));
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frameId = 0;
    let startedAt = performance.now();

    const setDot = (
      dot: SVGCircleElement,
      x: number,
      y: number,
      r: number,
      opacity: number,
    ) => {
      dot.setAttribute("cx", x.toFixed(2));
      dot.setAttribute("cy", y.toFixed(2));
      dot.setAttribute("r", r.toFixed(2));
      dot.setAttribute("opacity", opacity.toFixed(2));
    };

    const frame = (now: number) => {
      const elapsed = (now - startedAt) % 8240;
      const morph =
        elapsed < 5000
          ? 0
          : elapsed < 6296
            ? easeOrbMorph((elapsed - 5000) / 1296)
            : elapsed < 7160
              ? 1
              : elapsed < 7952
                ? 1 - easeOrbMorph((elapsed - 7160) / 792)
                : 0;
      const angle = (now / 2500) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      dots.forEach((dot, index) => {
        const sphere = ORB_SPHERE[index];
        const target = ORB_Z_TARGETS.get(index);
        if (!sphere) return;
        const [sx, sy, sz] = sphere;
        const orbX = 10 + 8.5 * (sx * cos + sz * sin);
        const orbY = 10 - 8.5 * sy;
        const depth = (-sx * sin + sz * cos + 1) / 2;
        const orbOpacity = index % 3 === 0 ? 0.35 + 0.6 * depth : 0;
        const stagger =
          morph === 0 || morph === 1
            ? morph
            : Math.max(
                0,
                Math.min(1, morph + (index / dots.length - 0.5) * 0.06),
              );
        const [zx, zy] = target ?? [orbX, orbY];
        const dx = zx - orbX;
        const dy = zy - orbY;
        const length = Math.hypot(dx, dy) || 1;
        const arc = Math.sin(Math.PI * stagger) * 0.45 * (index % 2 ? 1 : -1);
        setDot(
          dot,
          orbX + dx * stagger - (dy / length) * arc,
          orbY + dy * stagger + (dx / length) * arc,
          0.5,
          orbOpacity + ((target ? 1 : 0) - orbOpacity) * stagger,
        );
      });
      frameId = window.requestAnimationFrame(frame);
    };

    const updateMotion = () => {
      window.cancelAnimationFrame(frameId);
      if (reducedMotion.matches) {
        dots.forEach((dot, index) => {
          const target = ORB_Z_TARGETS.get(index);
          const [x, y] = target ?? [10, 10];
          setDot(dot, x, y, 0.5, target ? 1 : 0);
        });
      } else {
        startedAt = performance.now();
        frameId = window.requestAnimationFrame(frame);
      }
    };

    updateMotion();
    reducedMotion.addEventListener("change", updateMotion);
    return () => {
      window.cancelAnimationFrame(frameId);
      reducedMotion.removeEventListener("change", updateMotion);
    };
  }, []);

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className={cn(
        "size-5 shrink-0 overflow-visible text-[var(--brand)]",
        className,
      )}
    >
      <g
        ref={groupRef}
        fill="currentColor"
        style={{
          filter:
            "drop-shadow(0 0 0.2px color-mix(in srgb, currentColor 25%, transparent))",
        }}
      >
        {ORB_SPHERE.map((_, index) => {
          const target = ORB_Z_TARGETS.get(index);
          return (
            <circle
              key={index}
              cx={target?.[0] ?? 10}
              cy={target?.[1] ?? 10}
              r={0.5}
              opacity={target ? 1 : 0}
            />
          );
        })}
      </g>
    </svg>
  );
}
