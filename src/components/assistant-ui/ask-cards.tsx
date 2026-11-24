/**
 * ask 工具交互卡（docs/pi-coverage.md：ask 交互卡）。
 *
 * 每个挂起问题一张卡：单选 / 多选（pi 的 `multi`）+ 可选 "其他" 自由文本
 * + 取消。样式与 ApprovalCards 同款（去描边、composer 圆角）。
 *
 * 数据面：`askBridge`（`pi_ask_pending` 拉取，Rust AskRegistry 为真相）。
 * 应答：`pi_ask_response` → pi `AskTool::respond_ui`。
 *
 * **未用官方 `ElicitationForm`**：它的 `fields` 是静态展示（value 是字符串，
 * 没有选择交互），无法承载真实作答——用它只能看不能答（等于假 UI）。
 */
import { useEffect, useRef, useState } from 'react'

import { dispatchNativeNotification } from '@/lib/native-notify'
import { askBridge, useAskBridge, type AskQuestion, type PendingAsk } from './ask-bridge'

const cardClass = 'rounded-(--composer-radius) bg-(--surface) p-3 shadow-sm'
const chipBase =
  'rounded-full px-2.5 py-1 text-xs transition-colors disabled:opacity-50'

function QuestionBlock({
  q,
  selected,
  other,
  onToggle,
  onOther,
}: {
  q: AskQuestion
  selected: string[]
  other: string
  onToggle: (label: string) => void
  onOther: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline gap-2 text-xs text-(--text-3)">
        {q.header !== undefined && (
          <span className="font-medium tracking-wide uppercase">{q.header}</span>
        )}
        {q.multi && <span className="text-[10px]">可多选</span>}
      </div>
      <p className="text-sm text-(--text-1)">{q.question}</p>
      <div className="flex flex-wrap gap-1.5">
        {q.options.map((o, i) => {
          const active = selected.includes(o.label)
          return (
            <button
              key={o.label}
              type="button"
              title={o.description}
              onClick={() => onToggle(o.label)}
              className={`${chipBase} ${
                active
                  ? 'bg-foreground text-background'
                  : 'bg-foreground/[0.06] text-foreground/75 hover:bg-foreground/[0.1]'
              }`}
            >
              {o.label}
              {q.recommended === i && (
                <span className="ms-1 text-[10px] opacity-70">建议</span>
              )}
            </button>
          )
        })}
      </div>
      <input
        value={other}
        onChange={(e) => onOther(e.target.value)}
        placeholder="其他（自由输入，可留空）"
        className="h-7 min-w-0 rounded-md border border-border/60 bg-transparent px-2 text-xs outline-none focus:border-foreground/30"
      />
    </div>
  )
}

function AskCard({ item }: { item: PendingAsk }) {
  const [selected, setSelected] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (qi: number, label: string, multi: boolean) => {
    setSelected((prev) => {
      const cur = prev[qi] ?? []
      const next = multi
        ? cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label]
        : cur.includes(label)
          ? []
          : [label]
      return { ...prev, [qi]: next }
    })
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const answers = item.request.questions.map((q, i) => {
        const sel = selected[i] ?? []
        const oth = (other[i] ?? '').trim()
        return {
          questionId: q.id ?? String(i),
          selected: sel,
          ...(oth ? { other: oth } : {}),
        }
      })
      await askBridge.getState().respond(item.id, answers, false)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const dismiss = async () => {
    setBusy(true)
    setError(null)
    try {
      await askBridge.getState().respond(item.id, [], true)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  const answered = item.request.questions.every(
    (q, i) => (selected[i] ?? []).length > 0 || (other[i] ?? '').trim() !== '',
  )

  return (
    <div className={cardClass}>
      <div className="mb-2 flex items-center gap-2 text-xs text-(--text-3)">
        <span className="font-medium tracking-wide uppercase">需要你的回答</span>
        <span className="truncate">{item.request.questions.length} 个问题</span>
      </div>
      <div className="flex flex-col gap-3">
        {item.request.questions.map((q, i) => (
          <QuestionBlock
            key={q.id ?? i}
            q={q}
            selected={selected[i] ?? []}
            other={other[i] ?? ''}
            onToggle={(label) => toggle(i, label, q.multi)}
            onOther={(v) => setOther((prev) => ({ ...prev, [i]: v }))}
          />
        ))}
      </div>
      {error !== null && (
        <p className="mt-2 text-xs text-destructive">{error}</p>
      )}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !answered}
          onClick={() => void submit()}
          className={`${chipBase} bg-foreground text-background hover:opacity-90`}
        >
          提交
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void dismiss()}
          className={`${chipBase} bg-foreground/[0.06] text-foreground/70 hover:bg-foreground/[0.1]`}
        >
          取消
        </button>
      </div>
    </div>
  )
}

export function AskCards() {
  const { pending } = useAskBridge()
  const notifiedRef = useRef<Set<string>>(new Set())
  // rpi 的 ask_user 是插件 runtime action（不进 AgentEvent 流），SSE 上没有
  // ask_request 信号——卡片数据以 Rust 邮箱投影为真相，挂载即拉一次 +
  // 轮询（run 被工具调用卡住时用户必须看到问题卡）。无会话时命令返回
  // 空数组，轮询成本 = 锁内查表。
  useEffect(() => {
    void askBridge.getState().refresh()
    const timer = window.setInterval(() => {
      void askBridge.getState().refresh()
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])
  // 新提问 = 需要人：窗口失焦时弹 OS 通知（同一条提问只提醒一次）。
  useEffect(() => {
    const fresh = pending.filter((item) => !notifiedRef.current.has(item.id))
    if (fresh.length === 0) return
    for (const item of fresh) notifiedRef.current.add(item.id)
    const first = fresh[0]!.request.questions[0]?.question ?? '助手需要你的回答'
    dispatchNativeNotification({
      kind: 'input',
      title: '助手需要你的回答',
      body: first.slice(0, 160),
      tag: fresh[0]!.id,
    })
  }, [pending])
  if (pending.length === 0) return null
  return (
    <div className="mb-3 flex flex-col gap-2">
      {pending.map((item) => (
        <AskCard key={item.id} item={item} />
      ))}
    </div>
  )
}
