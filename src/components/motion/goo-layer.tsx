"use client";
// 统一弹层动效层 —— beui goo 表面（2026-10-26 用户定稿）
//
// 用户："能不能归拢成一个，现在输入框的模型选择，右键，左侧栏，三种效果，
// 所有的弹窗效果归拢成一个"。
//
// 归拢前的三种实现（各自为政，观感互不相同）：
//   1. 模型选择器 = components/motion/popover.tsx 的 goo（SVG feGaussianBlur
//      粘性形变 + shape() 形变）
//   2. 右键菜单   = components/motion/context-menu.tsx 的 clip-path 展开
//      （从落点 inset 摊开，无粘性）
//   3. 侧栏菜单   = Radix + CSS 的 opacity/scale 缩放淡入
//
// 本文件把 #1 的几何与渲染**抽成唯一实现**，popover 与 context-menu 都改
// 用它——从此只有一个动效来源，改观感只改这里。几何公式逐字来自 popover
// 原实现（buildGeo/rectAtProgress/insetFor/roundedRectShape/clipForProgress/
// triggerCutout），只是把"由 side/align 反推面板偏移"改成"直接收面板偏移"，
// 这样落点式菜单（只有坐标、没有触发元素）也能喂进来：
//
//   - 锚点式（Popover）：锚点矩形 = 触发钮 rect，面板偏移由 side/align/gap 算
//   - 落点式（ContextMenu）：锚点矩形 = 0×0 的点，面板偏移 = 面板左上 - 落点
//
// 落点式的锚点宽高为 0 时不做 trigger cutout（退化 path 无意义），面板从
// 那一点直接"长"出来——观感与模型选择器同源。

import {
  animate,
  useMotionValue,
  useMotionValueEvent,
  type MotionValue,
} from "motion/react";
import {
  type ComponentPropsWithoutRef,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { POPOVER_GOO, POPOVER_GOO_CLOSE, POPOVER_GOO_OPEN } from "@/lib/ease";
import { cn } from "@/lib/utils";

const CIRCLE_KAPPA = 0.5523;
const VIEWPORT_PADDING = 8;

export interface GooRect {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

export interface GooGeometry {
  /** 包围盒尺寸（锚点 + 面板） */
  layerW: number;
  layerH: number;
  /** 包围盒左上相对锚点左上的偏移（≤ 0） */
  left: number;
  top: number;
  anchor: GooRect;
  panel: GooRect;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * 锚点矩形与面板矩形在同一个局部坐标系里的包围盒。
 *
 * `panelX/panelY` = 面板左上角相对锚点左上角的偏移（可为负）。
 * 锚点式调用：`buildGooGeometry(tW, tH, px, py, cW, cH, radius)`，
 * 其中 px/py 由 side/align/gap 算出（见 popover.tsx）。
 * 落点式调用：`buildGooGeometry(0, 0, left - point.x, top - point.y, w, h, r)`。
 */
export function buildGooGeometry(
  anchorW: number,
  anchorH: number,
  panelX: number,
  panelY: number,
  panelW: number,
  panelH: number,
  panelRadius: number,
): GooGeometry {
  const left = Math.min(0, panelX);
  const top = Math.min(0, panelY);
  const layerW = Math.max(anchorW, panelX + panelW) - left;
  const layerH = Math.max(anchorH, panelY + panelH) - top;
  const anchorRadius = Math.min(anchorH / 2, panelRadius);

  return {
    layerW,
    layerH,
    left,
    top,
    anchor: { x: -left, y: -top, w: anchorW, h: anchorH, r: anchorRadius },
    panel: {
      x: panelX - left,
      y: panelY - top,
      w: panelW,
      h: panelH,
      r: panelRadius,
    },
  };
}

function rectAtProgress(
  geo: GooGeometry,
  progress: number,
  from?: GooRect,
): GooRect {
  const start = from ?? geo.anchor;
  const { panel } = geo;
  return {
    x: lerp(start.x, panel.x, progress),
    y: lerp(start.y, panel.y, progress),
    w: lerp(start.w, panel.w, progress),
    h: lerp(start.h, panel.h, progress),
    r: lerp(start.r, panel.r, progress),
  };
}

/**
 * `goo=false` 时的收起终点：面板**朝向锚点的那条边**，而不是触发钮。
 *
 * 为什么需要这个（2026-11-01 实测）：`goo=true` 时收起终点的 clip 是触发钮
 * 矩形，靠 `gooAnchorCutout` 把那块挖掉，所以按钮上看不到东西。`goo=false`
 * 时没有 cutout（没有锚点副本要挖），若仍收缩到触发钮矩形，面板会变成一块
 * 盖在按钮上的白色方块再消失——用户报的"白块跳闪"。
 *
 * 改成从面板朝向锚点的那条边展开/收回：几何上永远落在面板内部，任何
 * 进度下都不会越界到按钮上。
 *
 * 方向判定用**间隙**而不是中心距：锚点与面板通常有一条边对齐（align=start
 * 时两者左边重合），中心距会把"左边"判成最近边，于是面板横向压成一条竖线
 * ——观感错。间隙最大的那条边才是"面板从哪儿长出来"的那条。
 */
function collapseStartRect(geo: GooGeometry): GooRect {
  const { anchor, panel } = geo;
  const r = panel.r;
  const gapTop = panel.y - (anchor.y + anchor.h);
  const gapBottom = anchor.y - (panel.y + panel.h);
  const gapLeft = panel.x - (anchor.x + anchor.w);
  const gapRight = anchor.x - (panel.x + panel.w);
  const best = Math.max(gapTop, gapBottom, gapLeft, gapRight);

  if (best === gapTop) return { x: panel.x, y: panel.y, w: panel.w, h: 0, r };
  if (best === gapBottom)
    return { x: panel.x, y: panel.y + panel.h, w: panel.w, h: 0, r };
  if (best === gapLeft) return { x: panel.x, y: panel.y, w: 0, h: panel.h, r };
  return { x: panel.x + panel.w, y: panel.y, w: 0, h: panel.h, r };
}

function insetFor(rect: GooRect, layerW: number, layerH: number) {
  const top = rect.y;
  const right = layerW - (rect.x + rect.w);
  const bottom = layerH - (rect.y + rect.h);
  const left = rect.x;
  return `inset(${top}px ${right}px ${bottom}px ${left}px round ${rect.r}px)`;
}

function roundedRectShape(rect: GooRect) {
  const radius = Math.max(0, Math.min(rect.r, rect.w / 2, rect.h / 2));
  const control = radius * CIRCLE_KAPPA;
  const x1 = rect.x;
  const y1 = rect.y;
  const x2 = rect.x + rect.w;
  const y2 = rect.y + rect.h;
  const px = (value: number) => `${value.toFixed(3)}px`;

  return (
    `shape(from ${px(x1 + radius)} ${px(y1)}, ` +
    `line to ${px(x2 - radius)} ${px(y1)}, ` +
    `curve to ${px(x2)} ${px(y1 + radius)} with ${px(x2 - radius + control)} ${px(y1)} / ${px(x2)} ${px(y1 + radius - control)}, ` +
    `line to ${px(x2)} ${px(y2 - radius)}, ` +
    `curve to ${px(x2 - radius)} ${px(y2)} with ${px(x2)} ${px(y2 - radius + control)} / ${px(x2 - radius + control)} ${px(y2)}, ` +
    `line to ${px(x1 + radius)} ${px(y2)}, ` +
    `curve to ${px(x1)} ${px(y2 - radius)} with ${px(x1 + radius - control)} ${px(y2)} / ${px(x1)} ${px(y2 - radius + control)}, ` +
    `line to ${px(x1)} ${px(y1 + radius)}, ` +
    `curve to ${px(x1 + radius)} ${px(y1)} with ${px(x1)} ${px(y1 + radius - control)} / ${px(x1 + radius - control)} ${px(y1)}, ` +
    "close)"
  );
}

export function gooClipPath(
  geo: GooGeometry,
  progress: number,
  supportsShape: boolean,
  goo = POPOVER_GOO,
) {
  // goo=false 时收起终点换成"面板朝向锚点的那条边"（见 collapseStartRect
  // 的注释：否则会有一块盖住按钮的白方块）。goo=true 仍收进锚点矩形——
  // 那正是液滴脖子形成的过程，且锚点副本 + cutout 会让它不可见。
  const rect = rectAtProgress(geo, progress, goo ? undefined : collapseStartRect(geo));
  return supportsShape
    ? roundedRectShape(rect)
    : insetFor(rect, geo.layerW, geo.layerH);
}

function roundedRectPath(rect: GooRect) {
  const radius = Math.max(0, Math.min(rect.r, rect.w / 2, rect.h / 2));
  const n = (value: number) => value.toFixed(3);
  const x1 = rect.x;
  const y1 = rect.y;
  const x2 = rect.x + rect.w;
  const y2 = rect.y + rect.h;
  const arc = `A${n(radius)} ${n(radius)} 0 0 1`;

  // A zero radius makes every arc degenerate to a line, so this also draws
  // plain rectangles.
  return (
    `M${n(x1 + radius)} ${n(y1)}` +
    `H${n(x2 - radius)}${arc} ${n(x2)} ${n(y1 + radius)}` +
    `V${n(y2 - radius)}${arc} ${n(x2 - radius)} ${n(y2)}` +
    `H${n(x1 + radius)}${arc} ${n(x1)} ${n(y2 - radius)}` +
    `V${n(y1 + radius)}${arc} ${n(x1 + radius)} ${n(y1)}Z`
  );
}

/**
 * The goo layer is portalled above the page, so its copy of the trigger pill
 * would cover the real trigger's label and focus ring. Punching the trigger
 * back out keeps the real one visible and clips the blur to the layer box.
 * This is a clip path rather than a CSS mask on purpose: WebKit silently
 * ignores `mask: url(#id)` pointing at an SVG <mask> element, which left the
 * label hidden behind the goo in Safari.
 *
 * 落点式菜单的锚点是 0×0 的点（没有触发元素可挖），返回 undefined。
 */
export function gooAnchorCutout(geo: GooGeometry): string | undefined {
  if (geo.anchor.w <= 0 || geo.anchor.h <= 0) return undefined;
  const layer: GooRect = { x: 0, y: 0, w: geo.layerW, h: geo.layerH, r: 0 };
  return `path(evenodd, "${roundedRectPath(layer)} ${roundedRectPath(geo.anchor)}")`;
}

export interface GooSurfaceProps {
  /** 视口坐标：goo 层的原点 = 锚点左上角 */
  origin: { left: number; top: number };
  /** 面板超出视口左右缘时的整体平移补偿（0 = 不补偿） */
  clampX?: number;
  geo: GooGeometry;
  /** 0 = 收起（只见锚点），1 = 完全展开 */
  progress: MotionValue<number>;
  reduce: boolean;
  /** 模糊半径，喂给 goo filter。越大越"熔" */
  gooStrength: number;
  /**
   * 是否做**粘性合并**。
   *
   * **默认值 = 令牌 `--beui-popover-goo`（ease.ts 的 POPOVER_GOO）**，这是
   * 唯一开关——调用点不许传（2026-11-01 用户："调用点没传，直接在令牌中
   * 统一开关不行吗"）。
   *
   * 关掉时：不画锚点副本、不加 `url(#goo)` 滤镜——面板就是一个独立的
   * 圆角矩形 + 投影，触发钮与面板之间**没有液滴脖子**，投影也只落在面板
   * 上（不会给按钮也投一层）。
   *
   * 2026-11-01 用户："面板栏的按钮弹窗为什么有脖子，不是同一个组件吗？
   * 阴影也不对，脖子，按钮为什么也有阴影？"
   *
   * 背景：beui 的 Popover 是**通用**组件，液滴脖子是它的设计语言（预览页
   * 里 `PopoverPreview` 就是这效果）。但窄栏里的图标钮（28×28）+ 288 宽的
   * 大面板，两者尺寸悬殊、间隔 6px，粘性滤镜会把那 6px 拉成一条明显的
   * 脖子，且 drop-shadow 作用在合并形状上 → 按钮也被投了影。视觉上是
   * 噪声，不是设计。
   */
  goo?: boolean;
  /** 是否绘制（收起动画结束后可置 false 省一层合成） */
  visible: boolean;
  /** 打开时面板才接收指针 */
  interactive: boolean;
  contentRef: RefObject<HTMLDivElement | null>;
  contentId: string;
  /** SVG filter 的 id（必须与 contentId 不同——一个是 DOM id，一个是滤镜引用） */
  filterId: string;
  /**
   * 写到 portal 根上的 `data-menu-portal` 值（菜单用）。
   *
   * 菜单的外部点击判定要能认出"这个 portal 属于某个菜单"——子菜单是兄弟
   * portal，不在父 content 的 DOM 里，不标记就会被判成外部点击而整串关闭。
   */
  portalId?: string;
  /** 面板内容的缩放原点（仅 Popover 需要；菜单不缩放，可省） */
  transformOrigin?: string;
  /** goo 体（液滴）的底色类 */
  surfaceClassName?: string;
  /** 面板自身的类（底色/内距/圆角以外的一切） */
  contentClassName?: string;
  /** 落到面板 div 上的其余属性（role/aria/data-*） */
  contentProps?: Omit<ComponentPropsWithoutRef<"div">, "children">;
  children: ReactNode;
}

/**
 * goo 表面：SVG 粘性滤镜 + 从锚点长出（收回）的面板。
 *
 * 结构（与 beui 原版一致）：
 *   portal 根（fixed 到锚点）
 *     ├─ <svg><filter id=gooId>            ← 模糊 → alpha 锐化 → 叠原图
 *     ├─ goo 体（filter + 挖掉锚点）        ← 锚点 pill 副本 + 形变液滴
 *     └─ 裁剪层（与液滴同一 clip）           ← 面板内容，打开才可交互
 */
export function GooSurface({
  origin,
  clampX = 0,
  geo,
  progress,
  reduce,
  gooStrength,
  goo = POPOVER_GOO,
  visible,
  interactive,
  contentRef,
  contentId,
  filterId,
  portalId,
  transformOrigin,
  surfaceClassName = "bg-popover",
  contentClassName,
  contentProps,
  children,
}: GooSurfaceProps) {
  const blobRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const supportsShapeRef = useRef(false);

  useLayoutEffect(() => {
    supportsShapeRef.current =
      typeof CSS !== "undefined" &&
      typeof CSS.supports === "function" &&
      CSS.supports("clip-path", "shape(from 0px 0px, line to 1px 1px, close)");
  }, []);

  // Morph the same clip on the goo body and the content, so the whole surface
  // oozes as one and the text reveals with it.
  const paint = useCallback(
    (p: number) => {
      if (geo.layerW === 0) return;
      const clip = gooClipPath(geo, p, supportsShapeRef.current, goo);
      if (blobRef.current) blobRef.current.style.clipPath = clip;
      if (clipRef.current) clipRef.current.style.clipPath = clip;
    },
    [geo, goo],
  );

  useLayoutEffect(() => {
    paint(progress.get());
  }, [paint, progress]);
  useMotionValueEvent(progress, "change", paint);

  const cutout = gooAnchorCutout(geo);

  return (
    <div
      data-goo-portal=""
      data-menu-portal={portalId}
      className="pointer-events-none fixed left-0 top-0 z-[9999] isolate size-0"
      style={{
        visibility: visible ? "visible" : "hidden",
        transform: `translate3d(${origin.left + clampX}px, ${origin.top}px, 0)`,
      }}
    >
      {/* Goo filter: blur, sharpen the alpha back into solid shapes, then lay
          the crisp original on top so blobs merge with liquid edges. */}
      <svg aria-hidden width="0" height="0" className="absolute">
        <title>Popup visual effects</title>
        <defs>
          <filter id={filterId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur
              in="SourceGraphic"
              stdDeviation={gooStrength}
              result="blur"
            />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -10"
              result="goo"
            />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </defs>
      </svg>

      {/* Goo body: static anchor pill + morphing blob.
          
          **投影挂在这一层**（2026-11-01 二次修，用户："四个角为什么有黑边"）。
          
          前一版做法（独立兄弟层 + 黑色形状载体 + drop-shadow）是错的：
          载体本身是**不透明实心**（`bg-black`），CSS 没有"只输出 filter、
          不绘制元素"的开关——载体照常画出来，而它的 clip 是**整个图层
          矩形**（`shape(from 16px 34px …)`），比面板圆角更方，于是四角
          露出黑块。
          
          现在把 `drop-shadow` 直接挂在 goo body 这个盒子上：
          - 它的子元素（anchor pill + blob）就是面板的真实形状；
          - `drop-shadow` 取的是**子树合成后的 alpha**，所以阴影跟着面板
            圆角走，不会有方块；
          - 与 `filter: url(#goo)` 同时存在是合法的（CSS filter 列表可串联），
            写成 `url(#goo) drop-shadow(...)` 一条声明即可——顺序有意义：
            先做粘性合并，再对合并结果投影。
          - 收起时子树收缩到锚点大小，投影也同步收缩（不需要额外淡出），
            自然没有白块/黑块残留。

          **`goo=false` 时（2026-11-01 用户："为什么有脖子……按钮为什么
          也有阴影"）**：
          - 不画锚点副本（那个 28×28 的白块）——只留面板 blob；
          - 不加 `url(#goo)`——没有粘性合并，就没有那条把按钮与面板连起来
            的液滴脖子；
          - `drop-shadow` 因此只作用于面板形状，按钮不再被投影。
          `cutout`（挖掉锚点的 evenodd 路径）也随之跳过：没有锚点副本就
          不需要挖洞。 */}
      <div
        aria-hidden
        className="pointer-events-none absolute z-[-1]"
        style={{
          left: geo.left,
          top: geo.top,
          width: geo.layerW,
          height: geo.layerH,
          // 顺序：goo 粘性合并 → 对合并后的形状投影。reduce（用户禁动效）
          // 或 goo=false（不要脖子）时没有粘性滤镜，但投影仍要保留。
          filter:
            reduce || !goo
              ? "drop-shadow(0 4px 12px rgba(0, 0, 0, 0.16))"
              : `url(#${filterId}) drop-shadow(0 4px 12px rgba(0, 0, 0, 0.16))`,
          clipPath: goo ? cutout : undefined,
        }}
      >
        {goo && (
          <div
            className={cn("absolute", surfaceClassName)}
            style={{
              left: geo.anchor.x,
              top: geo.anchor.y,
              width: geo.anchor.w,
              height: geo.anchor.h,
              borderRadius: geo.anchor.r,
            }}
          />
        )}
        <div
          ref={blobRef}
          className={cn("absolute inset-0", surfaceClassName)}
          style={{ clipPath: gooClipPath(geo, progress.get(), false, goo) }}
        />
      </div>

      {/* Content is clipped by the same morph. The portal wrapper stays
          pointer-transparent; only the fully open panel accepts interaction. */}
      <div
        className="pointer-events-none absolute z-10"
        style={{
          left: geo.left,
          top: geo.top,
          width: geo.layerW,
          height: geo.layerH,
        }}
      >
        <div
          ref={clipRef}
          inert={!interactive}
          className="absolute inset-0"
          style={{
            clipPath: gooClipPath(geo, progress.get(), false, goo),
            pointerEvents: interactive ? "auto" : "none",
          }}
        >
          <div
            ref={contentRef}
            id={contentId}
            {...contentProps}
            style={{
              position: "absolute",
              left: geo.panel.x,
              top: geo.panel.y,
              transformOrigin,
              ...contentProps?.style,
            }}
            className={cn(contentClassName)}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
