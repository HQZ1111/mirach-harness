/**
 * 启动页（hermes `GatewayConnectingOverlay` 的宿主移植，2026-11-25；UI 用
 * ReactBits ParticleText 渲染 MIRACH 字标——用户指定）。
 *
 * 全链路语义：
 *   · 冷启动全屏实色遮罩，盖住整个壳（玻璃/透明模式也不透桌面）；
 *   · 连接中：品牌 logo + 粒子 MIRACH 字标 + 状态行；
 *   · 就绪：做**品牌接力**——启动页的 logo 与文字缩小并移动到左栏
 *     `.rail-logo-mark` / `.rail-logo-word` 的真实位置（FLIP：
 *     translate + scale，680ms），同时主壳内容从四面八方落位
 *     （每栏按位置取方向矢量，逐栏 60ms 递进）；接力完成即卸载遮罩，
 *     真实品牌在原位出现（几何一致，无跳变）。
 *   · 失败：遮罩保留，显示 IPC 原文错误 + 「重试」。
 *   · `prefers-reduced-motion`：不做 FLIP/落位编排，就绪即卸载。
 *
 * 防闪：最短展示 1200ms；热重载/已在线的窗口直接不渲染。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'

import ParticleText from '@/components/particle-text/ParticleText'
import {
  connectionBridge,
  useConnectionPhase,
} from '@/components/assistant-ui/connection-store'
import { bootBridge } from '@/lib/boot-store'
import { cn } from '@/lib/utils'

const HANDOFF_MS = 700
const MIN_SHOW_MS = 1200

type Phase = 'live' | 'handoff' | 'gone'

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

function clearRevealAttrs(): void {
  delete document.documentElement.dataset.launchReveal
  delete document.documentElement.dataset.launchRevealActive
  delete document.documentElement.dataset.launchHandoff
}

export function LaunchOverlay() {
  const bootPhase = useStore(bootBridge, (s) => s.phase)
  const bootError = useStore(bootBridge, (s) => s.error)
  const connectionPhase = useConnectionPhase()
  const [preview] = useState(forcedPreview)
  const [phase, setPhase] = useState<Phase>(() =>
    !preview && connectionBridge.getState().connected === true ? 'gone' : 'live',
  )
  const [minElapsed, setMinElapsed] = useState(false)
  const logoRef = useRef<HTMLImageElement | null>(null)
  const wordRef = useRef<HTMLSpanElement | null>(null)
  const handoffTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const id = window.setTimeout(() => setMinElapsed(true), MIN_SHOW_MS)
    return () => {
      window.clearTimeout(id)
      if (handoffTimerRef.current !== null) {
        window.clearTimeout(handoffTimerRef.current)
      }
      clearRevealAttrs()
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

  /**
   * 品牌接力：量测启动页元素与左栏真实品牌，算 FLIP transform；同时给每个
   * 栏设置方向矢量并触发落位动画。目标缺失（老布局/窄屏）则退回纯淡出。
   */
  const runHandoff = useCallback(() => {
    const logoEl = logoRef.current
    const wordEl = wordRef.current
    const railMark = document.querySelector<HTMLElement>('.rail-logo-mark')
    const railWord = document.querySelector<HTMLElement>('.rail-logo-word')
    if (!logoEl || !wordEl || !railMark || !railWord) {
      setPhase('gone')
      return
    }

    if (prefersReducedMotion()) {
      setPhase('gone')
      return
    }
    const html = document.documentElement

    // 1) 隐藏真实品牌 + 冻结壳内容（落位动画起点）。
    html.dataset.launchHandoff = ''
    html.dataset.launchReveal = ''

    // 2) 每栏方向矢量：按 x 排序 → 左/上/下/右四向。
    const groups = [...document.querySelectorAll<HTMLElement>('.dv-groupview')].sort(
      (a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left,
    )
    const dirs: [number, number][] = [
      [-1, 0],
      [0, -1],
      [0, 1],
      [1, 0],
    ]
    groups.forEach((group, index) => {
      const [dx, dy] = dirs[index % dirs.length]!
      group.style.setProperty('--launch-enter-x', `${dx * 64}px`)
      group.style.setProperty('--launch-enter-y', `${dy * 48}px`)
      group.style.setProperty('--launch-enter-delay', `${index * 70}ms`)
    })
    // 双 rAF：先让"隐藏"这一帧落地，再加 active 触发动画（避免浏览器合并
    // 两次样式变更导致动画不跑）。
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        html.dataset.launchRevealActive = ''
      })
    })

    // 3) FLIP：末态 transform 用"未变换基座"计算——scale 以中心为原点，
    //    所以当前 rect 中心就是基座中心；offsetWidth/Height 不受 transform 影响。
    const fromLogo = logoEl.getBoundingClientRect()
    const fromWord = wordEl.getBoundingClientRect()
    const toLogo = railMark.getBoundingClientRect()
    const toWord = railWord.getBoundingClientRect()
    const logoBaseW = logoEl.offsetWidth || 1
    const wordBaseW = wordEl.offsetWidth || 1
    const logoCenter = {
      x: fromLogo.left + fromLogo.width / 2,
      y: fromLogo.top + fromLogo.height / 2,
    }
    const wordCenter = {
      x: fromWord.left + fromWord.width / 2,
      y: fromWord.top + fromWord.height / 2,
    }
    const logoScale = toLogo.width / logoBaseW
    const wordScale = toWord.width / wordBaseW
    const ease = 'cubic-bezier(0.22, 1, 0.36, 1)'
    logoEl.style.transition = `transform ${HANDOFF_MS}ms ${ease}`
    wordEl.style.transition = `transform ${HANDOFF_MS}ms ${ease}`
    logoEl.style.transform = `translate(${toLogo.left + toLogo.width / 2 - logoCenter.x}px, ${
      toLogo.top + toLogo.height / 2 - logoCenter.y
    }px) scale(${logoScale})`
    wordEl.style.transform = `translate(${toWord.left + toWord.width / 2 - wordCenter.x}px, ${
      toWord.top + toWord.height / 2 - wordCenter.y
    }px) scale(${wordScale})`

    setPhase('handoff')
    handoffTimerRef.current = window.setTimeout(() => {
      handoffTimerRef.current = null
      setPhase('gone')
      clearRevealAttrs()
    }, HANDOFF_MS + 60)
  }, [])

  // 就绪 → 接力（dev 预览下不退出）。
  useEffect(() => {
    if (preview) return
    if (phase !== 'live' || bootPhase !== 'ready' || !minElapsed) return
    if (prefersReducedMotion()) {
      setPhase('gone')
      return
    }
    runHandoff()
  }, [bootPhase, minElapsed, phase, preview, runHandoff])

  if (phase === 'gone') return null

  const failed = bootPhase === 'failed'
  const handoff = phase === 'handoff'

  return (
    <div
      aria-busy={!failed && phase === 'live'}
      aria-live="polite"
      className={cn(
        'launch-overlay fixed inset-0 z-(--z-connecting) grid place-items-center',
        handoff && 'launch-overlay--handoff',
      )}
      role={failed ? 'alert' : 'status'}
    >
      {/* 背景单独一层：接力时先淡出它，壳内容在下面落位。 */}
      <div className="launch-overlay__bg" />

      <div className="relative flex w-[min(760px,86vw)] flex-col items-center gap-2">
        <div className="launch-overlay__brand">
          <img
            alt="Mirach"
            className="launch-overlay__logo"
            ref={logoRef}
            src="/brand/logo.png"
          />
        </div>

        <div className="launch-overlay__word-box">
          <div className="launch-overlay__particles">
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
          {/* 接力用的真实文字：基座样式 = 左栏 `.rail-logo-word`（同字号/
              字重/字距/颜色），初始放大 3×，FLIP 后与左栏文字完全重合。 */}
          <span className="launch-overlay__word" ref={wordRef}>
            Mirach
          </span>
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
          <p className="launch-overlay__status">正在启动 Mirach 引擎…</p>
        )}
      </div>
    </div>
  )
}
