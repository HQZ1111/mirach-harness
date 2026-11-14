/**
 * 个性（persona）页 —— OpenHuman「设置 → 个性」的完整移植（2026-10-26）。
 *
 * 用户："把 openhuman 设置里的个性完整，全链路复制，设置里的个性页做成一样的"。
 *
 * 源（openhuman app/src/components/settings/panels/）：
 *   PersonaPanel.tsx（343 行）—— 页壳
 *   persona/PersonaGuidedFields.tsx（93 行）—— 三字段结构化编辑器
 *   persona/PersonaTemplatePicker.tsx（95 行）—— 六角色模板卡
 *   persona/personaSections.ts（129 行）—— SOUL.md ⇄ 字段无损往返（逐字复制）
 *   persona/personaTemplates.ts（144 行）—— 模板种子文本（逐字复制）
 *
 * 结构逐块对应（不是精简版）：
 *   1. 身份卡   显示名 + 描述（界面字段，存 localStorage）
 *   2. 模板卡   六个角色起点 + 「自定义」态（guided 模式才显示）
 *   3. 角色卡   引导式三字段 / 高级原文编辑器（右上角切换）
 *   4. 保存条   有未保存改动才出现（放弃 / 保存更改）
 *
 * ── 与上游的差异（都是宿主事实，各有就地注释）──────────────────────
 * · 身份两字段：上游 redux-persist；宿主 localStorage（lib/persona-store.ts）。
 *   它们是"应用里怎么显示助手"的界面字段，不是提示词输入——放进 SOUL.md
 *   会改变语义。
 * · SOUL.md：上游走 core 的 workspace_file_* RPC；宿主走
 *   `pi_persona_read/write/reset`（落 `~/.pi/agent/SOUL.md`，会话创建时
 *   注入 append_system_prompt）。字段面与错误语义与上游一致。
 * · 「打开代理访问权限」链接：上游跳 agent-access 设置节。宿主没有该节
 *   （权限在会话内审批卡片上逐次决定）→ 该句只保留说明文字，不发假链接。
 * · 文案硬编码中文（宿主设置页无 i18n 运行时，AGENTS.md 规矩 2）；中文措辞
 *   逐条照抄上游 zh-CN 词条。
 */

import { RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { invoke } from '@tauri-apps/api/core'

import { inTauri } from '@/lib/tauri-window'
import {
  MAX_PERSONA_DESCRIPTION_LEN,
  MAX_PERSONA_DISPLAY_NAME_LEN,
  usePersona,
} from '@/lib/persona-store'
import {
  applyPersonaField,
  parsePersonaFields,
  type PersonaFieldKey,
} from './persona/personaSections'
import { applyTemplate, matchTemplate, PERSONA_TEMPLATES } from './persona/personaTemplates'

/** pi_persona_read / write / reset 的返回形状（对齐上游 WorkspaceFile）。 */
interface PersonaFile {
  filename: string
  contents: string
  isDefault: boolean
}

const MAX_FILE_BYTES = 256 * 1024

function describeIpcError(e: unknown): string {
  if (!inTauri) {
    return '浏览器直开模式：没有桌面宿主后端，个性设置不可读写（打包后的桌面应用里可用）'
  }
  return e instanceof Error ? e.message : String(e)
}

// ── 结构原语（上游 ui/{Card,Field,TextArea}）──────────────────────────

function Card({
  title,
  description,
  headerRight,
  children,
}: {
  title?: string
  description?: string
  headerRight?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="set-persona-card">
      {(title !== undefined || headerRight !== undefined) && (
        <div className="set-persona-card-head">
          <div className="set-persona-card-head-text">
            {title !== undefined && <h3 className="set-persona-card-title">{title}</h3>}
            {description !== undefined && (
              <p className="set-persona-card-desc">{description}</p>
            )}
          </div>
          {headerRight !== undefined && (
            <div className="set-persona-card-head-right">{headerRight}</div>
          )}
        </div>
      )}
      <div className="set-persona-card-body">{children}</div>
    </section>
  )
}

function Field({
  htmlFor,
  label,
  description,
  control,
}: {
  htmlFor?: string
  label: string
  description?: string
  control: React.ReactNode
}) {
  return (
    <div className="set-acct-field">
      <div className="set-acct-field-text">
        <label className="set-acct-field-label" htmlFor={htmlFor}>
          {label}
        </label>
        {description !== undefined && <p className="set-acct-field-desc">{description}</p>}
      </div>
      <div className="set-acct-field-control">{control}</div>
    </div>
  )
}

// ── 引导式三字段（上游 PersonaGuidedFields）──────────────────────────

const GUIDED_FIELDS: readonly {
  key: PersonaFieldKey
  label: string
  help: string
  placeholder: string
  testId: string
}[] = [
  {
    key: 'personality',
    label: '性格',
    help: '它的性格和价值观：它如何表现以及优先考虑什么。',
    placeholder: '例如：温暖、好奇、直接。对不确定坦诚。',
    testId: 'persona-guided-personality',
  },
  {
    key: 'voice',
    label: '沟通风格',
    help: '它组织回答的方式：长度、语气和格式。',
    placeholder: '例如：先给答案，简洁，并贴合我的语气。',
    testId: 'persona-guided-voice',
  },
  {
    key: 'about',
    label: '关于你',
    help: '它应记住的关于你的信息：工作、偏好和时区。',
    placeholder: '例如：我经营一家小型设计工作室，喜欢通俗的表达。',
    testId: 'persona-guided-about',
  },
]

function GuidedFields({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (next: string) => void
  disabled: boolean
}) {
  const fields = parsePersonaFields(value)
  return (
    <div className="set-persona-guided">
      {GUIDED_FIELDS.map((field) => (
        <div key={field.key}>
          <label className="set-persona-field-label" htmlFor={field.testId}>
            {field.label}
          </label>
          <p className="set-persona-field-help">{field.help}</p>
          <textarea
            aria-label={field.label}
            className="set-persona-textarea mt-2"
            data-testid={field.testId}
            disabled={disabled}
            id={field.testId}
            onChange={(e) => onChange(applyPersonaField(value, field.key, e.target.value))}
            placeholder={field.placeholder}
            rows={4}
            value={fields[field.key]}
          />
        </div>
      ))}
      <p className="set-persona-note">
        你手写的其他部分都会保留：切换到「高级」可查看完整角色设定。
      </p>
    </div>
  )
}

// ── 模板卡（上游 PersonaTemplatePicker）───────────────────────────────

function TemplatePicker({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (next: string) => void
  disabled: boolean
}) {
  const active = matchTemplate(value)
  return (
    <div aria-label="从模板开始" className="set-persona-templates" role="radiogroup">
      {PERSONA_TEMPLATES.map((template) => {
        const selected = active?.id === template.id
        return (
          <button
            aria-checked={selected}
            className={
              selected ? 'set-persona-tile set-persona-tile--on' : 'set-persona-tile'
            }
            data-testid={`persona-template-${template.id}`}
            disabled={disabled}
            key={template.id}
            onClick={() => onChange(applyTemplate(value, template))}
            role="radio"
            type="button"
          >
            <span className="set-persona-tile-title">{TEMPLATE_LABELS[template.id]?.label}</span>
            <span className="set-persona-tile-desc">{TEMPLATE_LABELS[template.id]?.desc}</span>
          </button>
        )
      })}
      {/* 自定义是状态不是动作：字段不再匹配任何模板时点亮，点击不做事。 */}
      <button
        aria-checked={active === null}
        className={
          active === null
            ? 'set-persona-tile set-persona-tile--on set-persona-tile--static'
            : 'set-persona-tile set-persona-tile--static'
        }
        data-testid="persona-template-custom"
        disabled={disabled}
        onClick={() => undefined}
        role="radio"
        type="button"
      >
        <span className="set-persona-tile-title">自定义</span>
        <span className="set-persona-tile-desc">您的组合: 编辑下面的字段</span>
      </button>
    </div>
  )
}

/** 模板卡的界面文案（上游 i18n 词条的 zh-CN 原文，逐条照抄）。 */
const TEMPLATE_LABELS: Record<string, { label: string; desc: string }> = {
  doctor: { label: '临床助手', desc: '严谨、引用来源、标注不确定' },
  researcher: { label: '研究助手', desc: '严谨、有条理、以证据为先' },
  executive: { label: '高管助手', desc: '简洁、果断、注重行动' },
  teacher: { label: '老师', desc: '有耐心、循序渐进地讲解' },
  student: { label: '学习搭子', desc: '鼓励式、出小测、通俗易懂' },
  family: { label: '家庭助手', desc: '温暖、友好、老少皆宜' },
}

// ── 页壳（上游 PersonaPanel）─────────────────────────────────────────

type SoulMode = 'guided' | 'advanced'

export function PersonaSettings() {
  const storedDisplayName = usePersona((s) => s.displayName)
  const storedDescription = usePersona((s) => s.description)
  const setDisplayName = usePersona((s) => s.setDisplayName)
  const setDescription = usePersona((s) => s.setDescription)

  const [nameDraft, setNameDraft] = useState(storedDisplayName)
  const [descriptionDraft, setDescriptionDraft] = useState(storedDescription)

  // 外部重置（如清除应用数据）时回同步草稿——否则"保存"会把旧值写回去
  // （上游同款两条 effect）。
  useEffect(() => setNameDraft(storedDisplayName), [storedDisplayName])
  useEffect(() => setDescriptionDraft(storedDescription), [storedDescription])

  const [soulDraft, setSoulDraft] = useState('')
  const [soulSaved, setSoulSaved] = useState('')
  const [soulIsDefault, setSoulIsDefault] = useState(true)
  const [soulLoading, setSoulLoading] = useState(true)
  const [soulError, setSoulError] = useState<string | null>(null)
  const [soulBusy, setSoulBusy] = useState(false)
  const [soulMode, setSoulMode] = useState<SoulMode>('guided')

  useEffect(() => {
    let cancelled = false
    void invoke<PersonaFile>('pi_persona_read')
      .then((file) => {
        if (cancelled) return
        setSoulDraft(file.contents)
        setSoulSaved(file.contents)
        setSoulIsDefault(file.isDefault)
        setSoulError(null)
      })
      .catch((e) => {
        if (cancelled) return
        setSoulError(describeIpcError(e))
      })
      .finally(() => {
        if (!cancelled) setSoulLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const nameDirty = nameDraft.trim() !== storedDisplayName
  const descriptionDirty = descriptionDraft.trim() !== storedDescription
  const identityDirty = nameDirty || descriptionDirty
  const soulDirty = soulDraft !== soulSaved
  const dirty = identityDirty || soulDirty

  const onSaveSoul = useCallback(async () => {
    setSoulBusy(true)
    setSoulError(null)
    try {
      const file = await invoke<PersonaFile>('pi_persona_write', { contents: soulDraft })
      setSoulDraft(file.contents)
      setSoulSaved(file.contents)
      setSoulIsDefault(file.isDefault)
    } catch (e) {
      setSoulError(describeIpcError(e))
    } finally {
      setSoulBusy(false)
    }
  }, [soulDraft])

  const onResetSoul = useCallback(async () => {
    setSoulBusy(true)
    setSoulError(null)
    try {
      const file = await invoke<PersonaFile>('pi_persona_reset')
      setSoulDraft(file.contents)
      setSoulSaved(file.contents)
      setSoulIsDefault(file.isDefault)
    } catch (e) {
      setSoulError(describeIpcError(e))
    } finally {
      setSoulBusy(false)
    }
  }, [])

  // 整页一个保存条：身份在本地、角色在磁盘，但对用户是一个表单——
  // 两个保存钮很容易只存一半（上游注释同语义）。
  const onSaveAll = useCallback(async () => {
    if (nameDirty) setDisplayName(nameDraft)
    if (descriptionDirty) setDescription(descriptionDraft)
    if (soulDirty) await onSaveSoul()
  }, [nameDirty, nameDraft, descriptionDirty, descriptionDraft, soulDirty, onSaveSoul, setDisplayName, setDescription])

  const onDiscard = useCallback(() => {
    setNameDraft(storedDisplayName)
    setDescriptionDraft(storedDescription)
    setSoulDraft(soulSaved)
    setSoulError(null)
  }, [storedDisplayName, storedDescription, soulSaved])

  const overCap = soulDraft.length > MAX_FILE_BYTES

  return (
    <div className="set-persona">
      {/* ── 1. 身份：助手在应用里怎么显示 ───────────────────────────── */}
      <Card
        description="助手的显示名称和简短描述。会显示在应用中；不会改变助手的推理方式。"
        title="身份"
      >
        <Field
          control={
            <input
              aria-label="显示名称"
              className="set-input w-72"
              data-testid="persona-display-name-input"
              id="persona-display-name"
              maxLength={MAX_PERSONA_DISPLAY_NAME_LEN}
              onChange={(e) => setNameDraft(e.target.value)}
              placeholder="例如 Nova"
              value={nameDraft}
            />
          }
          htmlFor="persona-display-name"
          label="显示名称"
        />
        <Field
          control={
            <input
              aria-label="描述"
              className="set-input w-72"
              data-testid="persona-description-input"
              id="persona-description"
              maxLength={MAX_PERSONA_DESCRIPTION_LEN}
              onChange={(e) => setDescriptionDraft(e.target.value)}
              placeholder="例如 为我的团队服务的冷静、简洁助手。"
              value={descriptionDraft}
            />
          }
          htmlFor="persona-description"
          label="描述"
        />
      </Card>

      {soulLoading ? (
        <Card>
          <p className="set-persona-note">正在载入…</p>
        </Card>
      ) : (
        <>
          {/* ── 2. 角色起点：选模板，或编辑后变「自定义」────────────── */}
          {soulMode === 'guided' && (
            <Card
              description="选择一个起点：它会填写「性格」和「沟通风格」。之后你可以随意修改。"
              title="从模板开始"
            >
              <div className="set-persona-card-pad">
                <TemplatePicker
                  disabled={soulBusy}
                  onChange={setSoulDraft}
                  value={soulDraft}
                />
              </div>
            </Card>
          )}

          {/* ── 3. 角色：SOUL.md 的受管小节，作为普通字段 ───────────── */}
          <Card
            description={
              soulMode === 'guided'
                ? '填写几个字段，我们会替你写入角色设定。无需 Markdown。'
                : '你的助手怎么想和说话 每次谈话都用它作为指示'
            }
            headerRight={
              <div
                aria-label="角色编辑器模式"
                className="set-persona-seg"
                role="group"
              >
                <button
                  aria-pressed={soulMode === 'guided'}
                  className={
                    soulMode === 'guided'
                      ? 'set-persona-seg-btn set-persona-seg-btn--on'
                      : 'set-persona-seg-btn'
                  }
                  data-testid="persona-soul-mode-guided"
                  onClick={() => setSoulMode('guided')}
                  type="button"
                >
                  引导式
                </button>
                <button
                  aria-pressed={soulMode === 'advanced'}
                  className={
                    soulMode === 'advanced'
                      ? 'set-persona-seg-btn set-persona-seg-btn--on'
                      : 'set-persona-seg-btn'
                  }
                  data-testid="persona-soul-mode-advanced"
                  onClick={() => setSoulMode('advanced')}
                  type="button"
                >
                  高级
                </button>
              </div>
            }
            title="角色"
          >
            <div className="set-persona-card-pad">
              {soulMode === 'guided' ? (
                <GuidedFields
                  disabled={soulBusy}
                  onChange={setSoulDraft}
                  value={soulDraft}
                />
              ) : (
                <textarea
                  aria-label="SOUL.md 内容"
                  className="set-persona-textarea set-persona-textarea--code"
                  data-testid="persona-soul-editor"
                  onChange={(e) => setSoulDraft(e.target.value)}
                  rows={14}
                  spellCheck={false}
                  value={soulDraft}
                />
              )}
            </div>
            <div className="set-persona-card-foot">
              <span className="set-persona-note">
                {soulIsDefault ? (
                  <span data-testid="persona-soul-default-badge">正在使用内置默认值</span>
                ) : null}
                {overCap ? (
                  <span className="set-err">
                    内容超过 {MAX_FILE_BYTES} 字节上限，无法保存
                  </span>
                ) : null}
              </span>
              <button
                className="set-btn set-btn--ghost"
                data-testid="persona-soul-reset"
                disabled={soulBusy || soulIsDefault}
                onClick={() => void onResetSoul()}
                type="button"
              >
                <RotateCcw className="size-[var(--size-icon-sm)]" aria-hidden />
                重置为默认值
              </button>
            </div>
          </Card>
        </>
      )}

      {soulError !== null && (
        <div className="set-err" data-testid="persona-soul-error" role="alert">
          {soulError}
        </div>
      )}

      {/* ── 单一保存条：有未保存改动才出现 ──────────────────────────── */}
      {dirty && (
        <div className="set-persona-savebar" data-testid="persona-save-bar">
          <span className="set-persona-savebar-text">您有未保存的更改</span>
          <div className="set-persona-savebar-actions">
            <button
              className="set-btn set-btn--ghost"
              disabled={soulBusy}
              onClick={onDiscard}
              type="button"
            >
              放弃
            </button>
            <button
              className="set-btn set-btn--primary"
              data-testid="persona-save"
              disabled={soulBusy || overCap}
              onClick={() => void onSaveAll()}
              type="button"
            >
              保存更改
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
