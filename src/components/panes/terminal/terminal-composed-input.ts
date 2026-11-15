/**
 * Windows 桌面中文输入法（IME）composed text 兜底——ZCode
 * packages/ui/src/terminal/terminalComposedInputFallback.ts 的移植。
 *
 * 为什么要有它（上游注释的教训，逐条保留）：
 * - 某些输入法（搜狗等）会把组合文本留在 xterm 的 textarea 里，
 *   xterm 可能只处理到一半；Linux Wayland 下确认会和 onData 重复写入，
 *   所以只收窄到 Windows 桌面（我们的壳是 Windows + CEF，移动端分支不移植）。
 * - 普通空格也会触发 composed input，且 xterm 已经通过 onData 写入 PTY：
 *   只看 textarea.value 会把空格再写一次，必须消费同一次输入附近的
 *   onData 去重。
 * - 输入法用 Enter/Process 提交候选词时，xterm 的 onData 可能把中文和
 *   控制符合并在同一个 chunk（中文 + 回车），整块判非 plain 会让兜底再写一次。
 *
 * 纯逻辑部分与上游逐字同源，接线见 terminal-pane.tsx。
 */

/** ESC（0x1b）——数值构造，源码里不出现裸控制字符 */
const ESC = String.fromCharCode(0x1b)

export interface PendingTerminalInputFallback {
  handled: boolean
  text: string
}

export interface TerminalInputFallbackKeydownCandidate {
  kind: 'text' | 'imeCommit'
  text: string | null
  eventTimeStamp: number
  recordedAt: number
}

export interface TerminalInputFallbackHandledData {
  consumed: boolean
  data: string
  keydownEventTimeStamp: number
  kind: 'text' | 'imeCommit' | 'recentData'
  recordedAt: number
}

export function createPendingTerminalInputFallback(text: string): PendingTerminalInputFallback {
  return {
    handled: false,
    text,
  }
}

function isPlainTerminalInputData(data: string): boolean {
  // 方向键等控制输入会产生 ESC 序列（例如上箭头）。这些序列里的普通字符
  // 不能参与 composed input 兜底匹配，否则可能把真实待补文本误判为已处理。
  return Array.from(data).every((char) => {
    const code = char.codePointAt(0)
    return code !== undefined && code >= 0x20 && code !== 0x7f
  })
}

function getPlainTerminalInputText(data: string): string | null {
  if (data.includes(ESC)) {
    return null
  }

  let text = ''
  for (const char of Array.from(data)) {
    const code = char.codePointAt(0)
    if (code !== undefined && code >= 0x20 && code !== 0x7f) {
      text += char
    }
  }

  return text.length > 0 ? text : null
}

function getHandledFallbackData(params: {
  candidate: TerminalInputFallbackKeydownCandidate
  data: string
}): string | null {
  if (params.candidate.kind === 'imeCommit') {
    // 搜狗等三方输入法用 Enter 提交候选词时，xterm 的 onData 可能把中文和
    // Enter 控制符合并在同一个 chunk。把整个 chunk 判为非 plain 会让
    // 后续 textarea input 兜底又写一次中文；这里只在 IME 提交键路径提取可打印文本。
    return getPlainTerminalInputText(params.data)
  }

  if (!isPlainTerminalInputData(params.data) || params.candidate.text !== params.data) {
    return null
  }

  return params.data
}

export function createTerminalInputFallbackKeydownCandidate(params: {
  eventTimeStamp: number
  key: string
  now: number
}): TerminalInputFallbackKeydownCandidate | null {
  if (params.key === 'Enter' || params.key === 'Process') {
    // 搜狗等三方中文输入法在 Windows 上常用 Enter/Process 提交候选词。
    // 此时 xterm 可能已经通过 onData 发出中文，随后 textarea input 又残留同一段组合文本；
    // 这里保留提交键时间戳，让后续 plain onData 能和同一拍 input 去重，避免再次兜底写入。
    return {
      eventTimeStamp: params.eventTimeStamp,
      kind: 'imeCommit',
      recordedAt: params.now,
      text: null,
    }
  }

  if (params.key.length !== 1 || !isPlainTerminalInputData(params.key)) {
    return null
  }

  return {
    eventTimeStamp: params.eventTimeStamp,
    kind: 'text',
    recordedAt: params.now,
    text: params.key,
  }
}

export function markTerminalInputFallbackHandled(
  pending: readonly PendingTerminalInputFallback[],
  data: string,
): void {
  const handledText = isPlainTerminalInputData(data) ? data : getPlainTerminalInputText(data)
  if (!handledText) {
    return
  }

  let remainingData = handledText
  for (const item of pending) {
    if (item.handled || item.text.length === 0) {
      continue
    }
    const index = remainingData.indexOf(item.text)
    if (index === -1) {
      continue
    }
    item.handled = true
    remainingData = remainingData.slice(0, index) + remainingData.slice(index + item.text.length)
  }
}

export function recordTerminalInputFallbackHandledData(params: {
  candidate: TerminalInputFallbackKeydownCandidate | null
  data: string
  history: readonly TerminalInputFallbackHandledData[]
  maxAgeMs: number
  now: number
}): {
  history: TerminalInputFallbackHandledData[]
  usedCandidate: boolean
} {
  const retainedHistory = params.history.filter(
    (item) => params.now - item.recordedAt <= params.maxAgeMs,
  )
  const candidate = params.candidate
  if (!candidate || params.now - candidate.recordedAt > params.maxAgeMs) {
    return {
      history: retainedHistory,
      usedCandidate: false,
    }
  }

  const data = getHandledFallbackData({ candidate, data: params.data })
  if (!data) {
    return {
      history: retainedHistory,
      usedCandidate: false,
    }
  }

  return {
    history: [
      ...retainedHistory,
      {
        consumed: false,
        data,
        keydownEventTimeStamp: candidate.eventTimeStamp,
        kind: candidate.kind,
        recordedAt: params.now,
      },
    ],
    usedCandidate: true,
  }
}

export function recordTerminalInputFallbackRecentData(params: {
  data: string
  history: readonly TerminalInputFallbackHandledData[]
  maxAgeMs: number
  now: number
}): TerminalInputFallbackHandledData[] {
  // 搜狗输入法提交候选词时，xterm 可能先通过 onData 写入中文，随后才派发
  // textarea composed input；这条路径没有稳定 keydown candidate，只能用极短窗口的 recentData 去重。
  const retainedHistory = params.history.filter(
    (item) => params.now - item.recordedAt <= params.maxAgeMs,
  )
  const data = isPlainTerminalInputData(params.data)
    ? params.data
    : getPlainTerminalInputText(params.data)
  if (!data) {
    return retainedHistory
  }

  return [
    ...retainedHistory,
    {
      consumed: false,
      data,
      keydownEventTimeStamp: params.now,
      kind: 'recentData',
      recordedAt: params.now,
    },
  ]
}

export function consumeTerminalInputFallbackHandledData(params: {
  history: readonly TerminalInputFallbackHandledData[]
  inputEventTimeStamp: number
  maxAgeMs: number
  maxInputDelayMs: number
  now: number
  pending: PendingTerminalInputFallback
}): void {
  const matched = params.history.find(
    (item) =>
      !item.consumed &&
      params.now - item.recordedAt <= params.maxAgeMs &&
      params.pending.text === item.data &&
      (item.kind === 'recentData'
        ? params.now - item.recordedAt <= params.maxInputDelayMs
        : params.inputEventTimeStamp >= item.keydownEventTimeStamp &&
          params.inputEventTimeStamp - item.keydownEventTimeStamp <=
            (item.kind === 'imeCommit' ? params.maxAgeMs : params.maxInputDelayMs)),
  )
  if (!matched) {
    return
  }

  matched.consumed = true
  params.pending.handled = true
}

export function resolveTerminalInputFallbackAction(params: {
  pending: PendingTerminalInputFallback
  textareaValue: string
}): {
  shouldClearTextarea: boolean
  shouldWrite: boolean
} {
  const hasTextareaValue = params.textareaValue.length > 0
  const shouldWrite = !params.pending.handled && hasTextareaValue
  return {
    shouldClearTextarea: hasTextareaValue && (params.pending.handled || shouldWrite),
    shouldWrite,
  }
}
