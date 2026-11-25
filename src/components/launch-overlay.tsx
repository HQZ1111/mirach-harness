/**
 * 启动页（hermes `GatewayConnectingOverlay` 的宿主移植，2026-11-25；UI 用
 * ReactBits ParticleText 渲染 MIRACH 字标——用户指定）。
 *
 * 全链路语义（对齐 hermes）：
 *   · 冷启动全屏遮罩，盖住整个壳（`--surface-shell-base` 实色；玻璃/透明
 *     模式下也不透桌面）；
 *   · 连接中：粒子字标 + 状态行；
 *   · 就绪：先字标退场（360ms 位移+淡出+去饱和）→ 停顿 300ms → 遮罩
 *     淡出 520ms → 卸载。热重载/已在线的窗口直接不渲染（不闪）；
 *   · 失败：遮罩保留，显示 IPC 原文错误 + 「重试」（bootStore.requestRetry
 *     触发 runtime 重跑端点发现/水合）；
 *   · `prefers-reduced-motion`：跳过退场编排与粒子进场（ParticleText 内部
 *     已处理），就绪即卸载。
 *
 * 最短展示 1200ms：引擎常常比 WebView 先就绪，直接按 online 淡出会"闪一下
 * 白屏"；最短窗口让启动页有完整的一次粒子聚合。
 */
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'

import ParticleText from '@/components/particle-text/ParticleText'
import {
  connectionBridge,
  useConnectionPhase,
} from '@/components/assistant-ui/connection-store'
import { bootBridge } from '@/lib/boot-store'
import { cn } from '@/lib/utils'

const TEXT_OUT_MS = 360
const POST_TEXT_HOLD_MS = 300
const OVERLAY_OUT_MS = 520
const MIN_SHOW_MS = 1200

type Phase = 'live' | 'text-out' | 'overlay-out' | 'gone'

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** dev 预览（hermes `?connecting=1` 同款）：本地调试启动页时循环展示。 */
function forcedPreview(): boolean {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false
  try {
    return new URLSearchParams(window.location.search).get('connecting') === '1'
  } catch {
    return false
  }
}

export function LaunchOverlay() {
  const bootPhase = useStore(bootBridge, (s) => s.phase)
  const bootError = useStore(bootBridge, (s) => s.error)
  const [preview] = useState(forcedPreview)
  const [phase, setPhase] = useState<Phase>(() =>
    // 热重载 / 已在线的窗口（dev HMR、主窗二次挂载）：不显示启动页。
    !preview && connectionBridge.getState().connected === true ? 'gone' : 'live',
  )
  const [minElapsed, setMinElapsed] = useState(false)
  const mountedRef = useRef(true)
  const connectionPhase = useConnectionPhase()

  useEffect(() => {
    mountedRef.current = true
    const id = window.setTimeout(() => setMinElapsed(true), MIN_SHOW_MS)
    return () => {
      mountedRef.current = false
      window.clearTimeout(id)
    }
  }, [])

  // 启动期异常收敛成可见失败：SSE 被浏览器放弃（dropped）或 45s 超时。
  // 都只在 booting 阶段生效——启动完成后断线由对话区横幅负责，不复活启动页。
  useEffect(() => {
    if (phase !== 'live' || bootPhase !== 'booting') return
    if (connectionPhase === 'dropped') {
      bootBridge.getState().setFailed('与引擎的事件流连接已断开（SSE dropped）')
    }
  }, [bootPhase, connectionPhase, phase])

  useEffect(() => {
    if (phase !== 'live' || bootPhase !== 'booting') return
    const id = window.setTimeout(() => {
      if (bootBridge.getState().phase === 'booting') {
        bootBridge.getState().setFailed('启动超时：45 秒内未连上引擎事件流')
      }
    }, 45_000)
    return () => window.clearTimeout(id)
  }, [bootPhase, phase])

  // 就绪 → 退场编排（reduced motion 直接卸载）。dev 预览下不退出。
  useEffect(() => {
    if (preview) return
    if (phase !== 'live' || bootPhase !== 'ready' || !minElapsed) return
    if (prefersReducedMotion()) {
      setPhase('gone')
      return
    }
    setPhase('text-out')
  }, [bootPhase, minElapsed, phase, preview])

  useEffect(() => {
    if (phase === 'text-out') {
      const id = window.setTimeout(
        () => setPhase('overlay-out'),
        TEXT_OUT_MS + POST_TEXT_HOLD_MS,
      )
      return () => window.clearTimeout(id)
    }
    if (phase === 'overlay-out') {
      const id = window.setTimeout(() => setPhase('gone'), OVERLAY_OUT_MS)
      return () => window.clearTimeout(id)
    }
  }, [phase])

  if (phase === 'gone') return null

  const leaving = phase !== 'live'
  const overlayHidden = phase === 'overlay-out'
  const failed = bootPhase === 'failed'

  return (
    <div
      aria-busy={!failed && phase === 'live'}
      aria-live="polite"
      className={cn(
        'launch-overlay fixed inset-0 z-(--z-connecting) grid place-items-center',
        'transition-opacity duration-500 ease-out',
        overlayHidden ? 'pointer-events-none opacity-0' : 'opacity-100',
      )}
      role={failed ? 'alert' : 'status'}
    >
      <div className="flex w-[min(760px,86vw)] flex-col items-center gap-3">
        <div
          className={cn(
            'launch-overlay__wordmark w-full transition duration-300 ease-out',
            leaving ? 'translate-y-2 opacity-0 saturate-0' : 'translate-y-0 opacity-100',
          )}
        >
          <ParticleText
            clickBurst={false}
            // 不传 color：ParticleText 默认 currentColor，会读容器的
            // getComputedStyle().color（var(--brand) 在这里已被浏览器解析）。
            // 传 "var(--brand)" 字符串给 canvas fillStyle 是**无效值**，粒子
            // 会静默落回黑色（实测）。
            density={5}
            fontSize="clamp(3.5rem, 14vw, 9rem)"
            fontWeight={800}
            gatherDuration={1500}
            glow
            highlightColor="#5aa2ff"
            idleDrift={0.5}
            intro="gather"
            particleSize={2.2}
            pointerRepel={24}
            repelRadius={110}
            stagger={380}
            text="MIRACH"
          />
        </div>

        {failed ? (
          <div className="launch-overlay__card" role="alert">
            <p className="launch-overlay__card-title">启动失败</p>
            <p className="launch-overlay__card-detail">{bootError}</p>
            <button
              className="set-btn set-btn-primary"
              onClick={() => bootBridge.getState().requestRetry()}
              type="button"
            >
              重试
            </button>
          </div>
        ) : (
          <p
            className={cn(
              'launch-overlay__status',
              leaving ? 'translate-y-2 opacity-0' : 'translate-y-0 opacity-100',
            )}
          >
            正在启动 Mirach 引擎…
          </p>
        )}
      </div>
    </div>
  )
}
