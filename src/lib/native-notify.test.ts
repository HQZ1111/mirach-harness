import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn(async (..._args: unknown[]) => true)
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, payload?: unknown) => invokeMock(cmd, payload),
}))

// The suite runs in a node environment with a localStorage stub; UI modules
// read `window.localStorage` and `document.hidden/hasFocus`, so provide both
// before importing the module.
;(globalThis as unknown as { window: unknown }).window = globalThis
const doc = { hidden: false, hasFocus: () => true }
;(globalThis as unknown as { document: unknown }).document = doc

const { dispatchNativeNotification, markNativeNotifyBaseline } = await import('./native-notify')

const PREFS_KEY = 'mirach:native-notifications'
const BASE = 1_000_000

function setPrefs(kinds?: Partial<Record<string, boolean>>, enabled = true) {
  globalThis.localStorage.setItem(
    PREFS_KEY,
    JSON.stringify({
      enabled,
      kinds: {
        approval: true,
        input: true,
        turnDone: true,
        turnError: true,
        backgroundDone: true,
        credits: true,
        plugin: true,
        ...kinds,
      },
    }),
  )
}

function background(hidden: boolean, focused: boolean) {
  doc.hidden = hidden
  doc.hasFocus = () => focused
}

beforeEach(() => {
  invokeMock.mockClear()
  globalThis.localStorage.clear()
  setPrefs()
  markNativeNotifyBaseline(0)
})

describe('dispatchNativeNotification（hermes 闸门对偶）', () => {
  it('窗口聚焦时回合完成不弹，失焦时弹一次', () => {
    background(false, true)
    expect(
      dispatchNativeNotification(
        { kind: 'turnDone', title: 'Mirach', body: 'done', sessionId: 's1', activeSessionId: 's1' },
        BASE,
      ),
    ).toBe(false)
    background(false, false)
    expect(
      dispatchNativeNotification(
        { kind: 'turnDone', title: 'Mirach', body: 'done', sessionId: 's1', activeSessionId: 's1' },
        BASE,
      ),
    ).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith('pi_notify', {
      title: 'Mirach',
      body: 'done',
      silent: false,
    })
  })

  it('非当前会话的回合完成不弹', () => {
    background(false, false)
    expect(
      dispatchNativeNotification(
        { kind: 'turnDone', title: 'other', body: 'done', sessionId: 's2', activeSessionId: 's1' },
        BASE,
      ),
    ).toBe(false)
  })

  it('审批提示聚焦时对其它会话也弹', () => {
    background(false, true)
    expect(
      dispatchNativeNotification(
        { kind: 'approval', title: '审批', body: 'bash', sessionId: 's2', activeSessionId: 's1' },
        BASE,
      ),
    ).toBe(true)
  })

  it('尊重偏好开关（整组关闭 / 单类关闭 / 静音）', () => {
    background(false, false)
    setPrefs(undefined, false)
    expect(
      dispatchNativeNotification(
        { kind: 'turnDone', title: 'Mirach', body: 'done', sessionId: 's1', activeSessionId: 's1' },
        BASE,
      ),
    ).toBe(false)
    setPrefs({ turnDone: false })
    expect(
      dispatchNativeNotification(
        { kind: 'turnDone', title: 'Mirach', body: 'done', sessionId: 's1', activeSessionId: 's1' },
        BASE,
      ),
    ).toBe(false)
    globalThis.localStorage.setItem('mirach.desktop.hapticsMuted', 'true')
    expect(
      dispatchNativeNotification(
        { kind: 'turnError', title: 'Mirach', body: 'failed', sessionId: 's1', activeSessionId: 's1' },
        BASE,
      ),
    ).toBe(true)
    expect(invokeMock).toHaveBeenLastCalledWith('pi_notify', {
      title: 'Mirach',
      body: 'failed',
      silent: true,
    })
  })

  it('启动静默窗内不弹，同 kind+会话 1s 内节流', () => {
    background(false, false)
    markNativeNotifyBaseline(BASE)
    expect(
      dispatchNativeNotification(
        { kind: 'turnDone', title: 'Mirach', body: 'done', sessionId: 's1', activeSessionId: 's1' },
        BASE + 1,
      ),
    ).toBe(false)
    expect(
      dispatchNativeNotification(
        { kind: 'turnDone', title: 'Mirach', body: 'done', sessionId: 's1', activeSessionId: 's1' },
        BASE + 5_000,
      ),
    ).toBe(true)
    expect(
      dispatchNativeNotification(
        { kind: 'turnDone', title: 'Mirach', body: 'done', sessionId: 's1', activeSessionId: 's1' },
        BASE + 5_500,
      ),
    ).toBe(false)
    expect(
      dispatchNativeNotification(
        { kind: 'turnDone', title: 'Mirach', body: 'done', sessionId: 's1', activeSessionId: 's1' },
        BASE + 6_100,
      ),
    ).toBe(true)
  })
})