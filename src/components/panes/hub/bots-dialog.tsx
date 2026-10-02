/**
 * 机器人新建/编辑表单（BotsDialog）——hermes plugins/hermes-bots
 * create-dialog.tsx 的最小照抄（名字/描述 + General 段：模型下拉 + 工作区
 * 目录选择；Avatar/分组/克隆等 pi 无承载的面不造 UI，逐项注释）。
 *
 * hermes 逐项对照（create-dialog.tsx）：
 * - 表单四件套：Name（:627-630 Input autoFocus）/ Title / Description
 *   （:675-687）/ Advanced General 段（:738-788）——harness 合并为一张表
 *   （Name+Description+Model+CWD，pi 四项即全部可承载）；
 * - taken 查重提示（:631-637）——同名 bot 拒绝（红线提示）；
 * - ModelPicker（:764-779）——harness = <select> 读 model-catalog-store
 *   （pi_list_models 目录，composer-wired 的共享投影）；
 * - Avatar（:614-626 BotFace/AvatarPicker）/ Create on 连接选择（:641-671
 *   多网关）/ Clone from profile（:741-762）/ SOUL.md（:780-788）——pi 无
 *   对等承载（bot=一份 SessionOptions 参数包），不造 UI（宁缺毋滥）。
 *
 * 提交 = botsStore.upsert（预设落盘）→ callbacks.launched（bots-pane 接管
 * 启动会话）。hermes 的"创建即开天初始对话"（:541-561 createCanonicalChat
 * kickoff）——harness 启动词在启动钮上（新建≠启动，语义分离：存预设不必
 * 起会话），本表单只保存。
 *
 * 视觉照抄 settings-overlay 族（portal + .set-card 主从两栏 + .set-field
 * 表单行）；目录选择 = tauri plugin-dialog open（thread-list.aui
 * onPickWorkspace 同款）。禁止 innerHTML。
 */

import { useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { Bot, XIcon } from 'lucide-react'

import { useModelCatalog, modelCatalogStore } from '@/components/assistant-ui/model-catalog-store'
import { ESCAPE_PRIORITY, isTopEscapeLayer, pushEscapeLayer } from '@/lib/escape-layers'

import { botsStore, splitBotModel, useBotsStore, type BotPreset } from './bots-store'

/** 提交回调（launched 由 bots-pane 注入——保存后启动会话）。 */
export interface BotsDialogCallbacks {
  launched?: (bot: BotPreset) => void
}

/** 新建/编辑表单浮层。editing = null 新建；非 null 编辑该 bot。 */
export function BotsDialog({
  callbacks,
  editing,
  onClose,
}: {
  callbacks: BotsDialogCallbacks
  editing: BotPreset | null
  onClose: () => void
}) {
  // 表单四件套初值 = 编辑对象或空（hermes create-dialog reset 语义）
  const [name, setName] = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [systemPrompt, setSystemPrompt] = useState(editing?.systemPrompt ?? '')
  const [model, setModel] = useState(editing?.model ?? '')
  const [cwd, setCwd] = useState(editing?.cwd ?? '')

  // 模型目录（model-catalog-store：pi_list_models 共享投影；打开时拉取）
  const catalog = useModelCatalog((s) => s.entries)
  useEffect(() => {
    void modelCatalogStore.getState().load()
  }, [])

  const bots = useBotsStore((s) => s.bots)
  // taken 查重（hermes create-dialog:631-637 同语义；编辑本名不撞自己）
  const taken = useMemo(
    () => bots.some((b) => b.name === name.trim() && b.name !== editing?.name),
    [bots, name, editing],
  )
  // 模型形状校验（有值必须 provider/model——splitBotModel 的 null 边界）
  const modelInvalid = model.trim() !== '' && splitBotModel(model).provider === null
  const valid = name.trim().length > 0 && !taken && !modelInvalid

  // Escape 分层（settings-overlay 同款）
  useEffect(() => {
    const disposeEscape = pushEscapeLayer(ESCAPE_PRIORITY.overlay)
    return () => disposeEscape()
  }, [])

  const onEscape = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' && isTopEscapeLayer(ESCAPE_PRIORITY.overlay)) {
      e.stopPropagation()
      onClose()
    }
  }

  const onPickWorkspace = async () => {
    try {
      const dir = await openDialog({ directory: true })
      if (!dir || typeof dir !== 'string') return
      setCwd(dir)
    } catch (e) {
      console.error('[bots] 工作区选择失败（Tauri 对话框不可用？）', e)
    }
  }

  const submit = () => {
    if (!valid) return
    const preset: BotPreset = {
      name: name.trim(),
      description: description.trim(),
      systemPrompt: systemPrompt.trim(),
      model: model.trim(),
      cwd: cwd.trim(),
      createdAt: editing?.createdAt ?? Date.now(),
    }
    // Duplicate 名也可建（hermes duplicateBot 语义——upsert 按 name 键）
    botsStore.getState().upsert(preset, editing?.name)
    callbacks.launched?.(preset)
    onClose()
  }

  return createPortal(
    <div className="set-overlay" onClick={onClose} onKeyDown={onEscape} role="presentation">
      <div
        aria-label={editing ? '编辑机器人' : '新建机器人'}
        aria-modal="true"
        className="set-card"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="set-header">
          <h2 className="set-title">
            <Bot aria-hidden className="set-title-icon" size={14} />
            {editing ? '编辑机器人' : '新建机器人'}
          </h2>
          <div className="set-header-actions">
            <button aria-label="关闭" className="set-close" onClick={onClose} type="button">
              <XIcon size={14} />
            </button>
          </div>
        </div>
        {/* 单栏内容（四件套一行一个；无左导航必要——节数 < 3） */}
        <div className="set-content">
          <section className="set-section">
            <div className="set-field">
              <label className="set-field-label" htmlFor="bot-name">名称</label>
              <div className="set-field-control">
                <input
                  autoFocus
                  className="set-input"
                  id="bot-name"
                  onChange={(e) => setName(e.target.value)}
                  placeholder="inbox-triage"
                  value={name}
                />
              </div>
            </div>
            {taken && (
              <div className="set-err">名为「{name.trim()}」的机器人已存在。</div>
            )}
            <div className="set-field">
              <label className="set-field-label" htmlFor="bot-desc">描述</label>
              <div className="set-field-control">
                <input
                  className="set-input"
                  id="bot-desc"
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="这台机器人做什么……"
                  value={description}
                />
              </div>
            </div>
            <div className="set-field">
              <label className="set-field-label" htmlFor="bot-system">System prompt</label>
              <div className="set-field-control">
                <textarea
                  className="set-textarea"
                  id="bot-system"
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="机器人的人格与行为准则（可选）——"
                  rows={4}
                  value={systemPrompt}
                />
              </div>
            </div>
            <div className="set-field">
              <label className="set-field-label" htmlFor="bot-model">模型</label>
              <div className="set-field-control">
                <select
                  className="set-select"
                  id="bot-model"
                  onChange={(e) => setModel(e.target.value)}
                  value={model}
                >
                  <option value="">继承 pi 默认（settings.json）</option>
                  {catalog.map((m) => (
                    <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                      {m.name || m.id} — {m.provider}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {modelInvalid && (
              <div className="set-err">模型形状非法（应为 provider/model）——重新选择。</div>
            )}
            <div className="set-field">
              <label className="set-field-label" htmlFor="bot-cwd">工作区</label>
              <div className="set-field-control">
                <input
                  className="set-input"
                  id="bot-cwd"
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="进程目录（默认）"
                  readOnly
                  value={cwd}
                />
                <button className="set-btn" onClick={() => void onPickWorkspace()} type="button">
                  选择目录…
                </button>
                {cwd && (
                  <button className="set-btn" onClick={() => setCwd('')} type="button">
                    清除
                  </button>
                )}
              </div>
            </div>
            <p className="set-hint">
              保存 = 预设入库（本地镜像，真相边界见 bots-store）。启动 = 
              以该配置开新会话（pi_create_bot_session：system_prompt + model +
              working_directory 一次性给足）。
            </p>
            <div className="set-actions">
              <button className="set-btn" onClick={onClose} type="button">
                取消
              </button>
              <button
                className="set-btn set-btn-primary"
                disabled={!valid}
                onClick={submit}
                type="button"
              >
                {editing ? '保存' : '保存预设'}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}
