/**
 * 设置页「语音」节（基础设置 → 语音，2026-11-12）——GPT-Live 双工语音的
 * 配置面。hermes 的对应面在 gateway config（voice.voice_chat_mode /
 * voice.gpt_live.*）；宿主数据面 = pi_voice_live_set_config（settings.json
 * `voice` 段读-改-写，persist_voice_live_config）。
 *
 * 字段：
 * - 引擎模式（chained / gpt-live 单选；chained 的 STT/TTS 链宿主无提供方
 *   ——选项如实标注"未接通"，选了也不会有语音，但仍是合法默认态）；
 * - OpenAI API key（password 输入，**只写不读**——状态区只报已配置/未配置，
 *   保存后不回显；空串提交 = 清除）；
 * - 模型 / 音色（留空 = gpt-live-1 / marin 默认）；
 * - 就绪状态读数（available/mode/model/voice/reason——pi_voice_live_status，
 *   保存后自动刷新）。
 *
 * **不造假**：状态直接来自宿主桥的判定（key 链 = settings → 环境变量）；
 * 未配置 key 时 gpt-live 启动钮的红显理由就是这里的 reason 字符串。
 */
import { FC, useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'

import { voiceLiveStore } from '@/components/assistant-ui/voice-live-store'
import type { VoiceLiveStatus } from '@/lib/voice-live'
import { cn } from '@/lib/utils'

type EngineMode = 'chained' | 'gpt-live' | 'moss-live'

export const VoiceSettings: FC = () => {
  const [status, setStatus] = useState<VoiceLiveStatus | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [mode, setMode] = useState<EngineMode>('chained')
  const [apiKey, setApiKey] = useState('')
  const [mossApiKey, setMossApiKey] = useState('')
  const [model, setModel] = useState('')
  const [voice, setVoice] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const refresh = () => {
    void invoke<VoiceLiveStatus & { ok?: boolean }>('pi_voice_live_status')
      .then((s) => {
        setStatus(s)
        setMode(s.mode === 'gpt-live' ? 'gpt-live' : s.mode === 'moss-live' ? 'moss-live' : 'chained')
        setModel(s.model === 'gpt-live-1' ? '' : s.model)
        setVoice(s.voice === 'marin' ? '' : s.voice)
        setLoadError(null)
      })
      .catch((e) => {
        console.error('[voice-settings] 状态读取失败', e)
        setLoadError(String(e))
      })
  }
  useEffect(refresh, [])

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const next = await invoke<VoiceLiveStatus>('pi_voice_live_set_config', {
        apiKey: apiKey.trim() ? apiKey.trim() : undefined,
        mode,
        model: model.trim() || undefined,
        voice: voice.trim() || undefined,
        mossApiKey: mossApiKey.trim() ? mossApiKey.trim() : undefined,
      })
      setStatus(next)
      setMode(next.mode === 'gpt-live' ? 'gpt-live' : next.mode === 'moss-live' ? 'moss-live' : 'chained')
      setSaved(true)
      // composer 的语音钮读同一个桥——保存后立即可用
      voiceLiveStore.getState().refresh()
      window.setTimeout(() => setSaved(false), 2500)
    } catch (e) {
      setSaveError(String(e))
    } finally {
      setSaving(false)
    }
  }

  if (loadError) {
    return (
      <section className="set-section">
        <div className="set-err" role="alert">
          语音桥状态读取失败：{loadError}（应用二进制缺 pi_voice_live？）
        </div>
      </section>
    )
  }

  return (
    <section className="set-section">
      {/* 引擎模式（hermes voice.voice_chat_mode + 宿主扩的 moss-live；chained
          的 STT/TTS 链宿主无提供方——红显如实标注，选项本身是合法默认态） */}
      <div className="set-field">
        <label className="set-field-label">引擎模式</label>
        <div className="flex flex-col gap-1">
          {(
            [
              ['chained', '链式（语音转文字 → 会话 → 文字转语音）'],
              ['gpt-live', 'GPT-Live（全双工语音，OpenAI gpt-live-1）'],
              ['moss-live', 'MOSS-Live（全双工语音，模思智能 moss-live-1.0）'],
            ] as const
          ).map(([value, label]) => (
            <button
              className={cn(
                'hover:bg-accent/60 flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                mode === value && 'bg-accent/80',
              )}
              key={value}
              onClick={() => setMode(value)}
              type="button"
            >
              <span
                aria-hidden
                className={cn(
                  'flex size-3.5 shrink-0 items-center justify-center rounded-full border',
                  mode === value && 'border-(--color-brand)',
                )}
              >
                {mode === value && (
                  <span className="bg-(--color-brand) size-2 rounded-full" />
                )}
              </span>
              <span className="min-w-0">
                <span className="text-foreground block">{label}</span>
                {value === 'chained' && (
                  <span className="text-rose-600 dark:text-rose-400 block text-[0.625rem]" data-stub="true">
                    链式的语音转文字/文字转语音提供方宿主未接通——切到该模式不会有语音
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* MOSS key（模思开放平台 platform.moss.cn 的 API key——与 OpenAI 链
          独立；只写不读同规） */}
      <div className="set-field">
        <label className="set-field-label" htmlFor="voice-moss-key">MOSS API key（模思开放平台）</label>
        <div className="set-field-control">
          <input
            autoComplete="off"
            className="set-input"
            id="voice-moss-key"
            onChange={(e) => setMossApiKey(e.target.value)}
            placeholder={
              status?.mossAvailable ? '已配置（输入新值覆盖，留空不动）' : '未配置——platform.moss.cn 的 API key'
            }
            type="password"
            value={mossApiKey}
          />
        </div>
        <p className="set-hint">
          MOSS-Live 模式用；也可用环境变量 MOSS_API_KEY（本设置优先）。
          状态：{status?.mossAvailable ? '已配置' : '未配置'}
          {status?.mossReason ? `（${status.mossReason}）` : ''}
        </p>
      </div>

      {/* key（只写不读——placeholder 报已配置状态而非回显） */}
      <div className="set-field">
        <label className="set-field-label" htmlFor="voice-api-key">OpenAI API key</label>
        <div className="set-field-control">
          <input
            autoComplete="off"
            className="set-input"
            id="voice-api-key"
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              status?.available ? '已配置（输入新值覆盖，留空不动）' : '未配置——粘贴 sk-… 开头的项目 key'
            }
            type="password"
            value={apiKey}
          />
        </div>
        <p className="set-hint">
          只写不读——保存后状态区只报「已配置/未配置」，不回显 key 本身。
          也可用环境变量 OPENAI_API_KEY（本设置优先）。
        </p>
      </div>

      {/* 模型 / 音色（留空 = 官方默认） */}
      <div className="set-field">
        <label className="set-field-label" htmlFor="voice-model">模型（留空 = gpt-live-1）</label>
        <div className="set-field-control">
          <input
            className="set-input"
            id="voice-model"
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-live-1"
            value={model}
          />
        </div>
      </div>
      <div className="set-field">
        <label className="set-field-label" htmlFor="voice-timbre">音色（留空 = marin）</label>
        <div className="set-field-control">
          <input
            className="set-input"
            id="voice-timbre"
            onChange={(e) => setVoice(e.target.value)}
            placeholder="marin / cedar / quartz / …"
            value={voice}
          />
        </div>
      </div>

      {/* 就绪状态（真相 = 宿主桥的判定；未配 key 时启动钮的红显就是这里
          的 reason） */}
      <div className="set-field">
        <label className="set-field-label">就绪状态</label>
        <div className="text-muted-foreground rounded-md border border-border/60 px-2 py-1.5 text-xs">
          {status ? (
            <>
              <span className={cn('mr-1.5 inline-block size-1.5 rounded-full align-middle', status.available ? 'bg-emerald-500' : 'bg-rose-500')} />
              {status.available ? (
                <>GPT-Live 可启动（模式 {status.mode} · {status.model} · 音色 {status.voice}）</>
              ) : (
                <>GPT-Live 不可启动——{status.reason}（当前模式 {status.mode}）</>
              )}
              <div className="mt-1">
                <span className={cn('mr-1.5 inline-block size-1.5 rounded-full align-middle', status.mossAvailable ? 'bg-emerald-500' : 'bg-rose-500')} />
                {status.mossAvailable ? (
                  <>MOSS-Live 可启动（模思 {status.mossModel}）</>
                ) : (
                  <>MOSS-Live 不可启动——{status.mossReason}</>
                )}
              </div>
            </>
          ) : (
            '读取中…'
          )}
        </div>
        <p className="set-hint">
          接通说明：GPT-Live（OpenAI）按语音时长计秒，agent turn 计费分离；
          MOSS-Live（模思，WSS api.mosi.cn）委托同样给当前 Mirach 会话
          （模型/工具/审批全走 pi）。两条链的委托回路共用同一驱动。
        </p>
      </div>

      {saveError && <div className="set-err">{saveError}</div>}

      <div className="set-actions">
        <button
          className="set-btn set-btn-primary pressable"
          disabled={saving}
          onClick={() => void save()}
          type="button"
        >
          {saving ? '保存中…' : saved ? '已保存 ✓' : '保存'}
        </button>
      </div>
    </section>
  )
}
