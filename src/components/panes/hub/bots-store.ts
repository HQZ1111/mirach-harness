/**
 * 机器人花名册存储（左栏「机器人」窗格 + BotsDialog 的共享投影）。
 *
 * bot 数据形状（hermes plugins/hermes-bots types.ts 的最小对偶——hermes
 * bot = profile 预设，字段取 pi 能承载的四项）：
 * - name：bot 名（会话以此命名，rename_session 语义）；
 * - systemPrompt：机器人人格（SessionOptions.system_prompt，sdk.rs:308）；
 * - provider/model：模型预设（"provider/modelId"——model-catalog-store
 *   的 id 形状一致，create_session_opts 拆分传参）；
 * - cwd：工作区目录（SessionOptions.working_directory，sdk.rs:311）；
 * - createdAt：创建时间戳（hermes BotMeta.created 同语义）。
 *
 * **存储裁定：本地 JSON（mirach.harness.bots.v1），不用 pi settings。**
 * 论证：①pi settings.json 是**全局单文档**（pi_settings.rs settings_path
 * 唯一路径），写 bot 预设要把自家 schema（Config 结构校验
 * validate_settings_document）外的键塞进去——pi 升级收键即坏；②bot 预设
 * 是**桌面侧的展示概念**（每个 bot = 一份 SessionOptions 参数包），真相
 * 边界与会话一致——会话真相在 pi、预设真相在宿主；③hermes 的 bot meta
 * 也是 profile.yaml ui_meta 之外的本地 plugin storage（data.ts saveBotMeta
 * 语义），宿主自存是照抄不是发明。
 *
 * zustand vanilla store（connection-store / session-workspace 同款形态）；
 * localStorage 持久化（layout-store 迁移先例：读写时机显式——load 挂载
 * 读、save 即写）。禁止兜底：JSON 损坏 console.error 后按空表起步（首次
 * 使用 = 无文件的正常态；损坏文件保留在键上不覆盖——用户可手动恢复）。
 */

import { createStore, useStore } from 'zustand'

/** 机器人预设（hermes bot 的 pi 对偶：一份 SessionOptions 参数包）。 */
export interface BotPreset {
  name: string
  systemPrompt: string
  /** "provider/modelId"（model-catalog-store 的 id 形状）；空串 = pi 默认 */
  model: string
  /** 工作区目录；空串 = 进程 cwd */
  cwd: string
  description: string
  createdAt: number
}

interface BotsState {
  bots: BotPreset[]
  load: () => void
  save: (bots: BotPreset[]) => void
  upsert: (bot: BotPreset, previousName?: string) => void
  remove: (name: string) => void
}

const STORAGE_KEY = 'mirach.harness.bots.v1'

/** React 订阅（bots-pane / bots-dialog 用）。 */
export const useBotsStore = <T,>(selector: (s: BotsState) => T): T =>
  useStore(botsStore, selector)

const parseStored = (raw: string | null): BotPreset[] => {
  if (raw === null) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    // 坏文档可见不覆盖（用户可手动恢复该键）——禁止静默清场
    console.error('[bots] 存储解析失败——按空表起步（原值保留未覆盖）', e)
    return []
  }
  if (!Array.isArray(parsed)) {
    console.error('[bots] 存储形状非法（应为数组）——按空表起步', parsed)
    return []
  }
  return parsed.filter(
    (b): b is BotPreset =>
      typeof b === 'object' &&
      b !== null &&
      typeof (b as BotPreset).name === 'string' &&
      (b as BotPreset).name.length > 0,
  )
}

export const botsStore = createStore<BotsState>((set, get) => ({
  bots: [],
  load: () => {
    set({ bots: parseStored(localStorage.getItem(STORAGE_KEY)) })
  },
  save: (bots) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bots))
    set({ bots })
  },
  upsert: (bot, previousName) => {
    const trimmed = bot.name.trim()
    if (!trimmed) {
      console.error('[bots] 空名称——忽略')
      return
    }
    const rest = get().bots.filter((b) => b.name !== trimmed && b.name !== previousName)
    get().save([...rest, { ...bot, name: trimmed }])
  },
  remove: (name) => {
    get().save(get().bots.filter((b) => b.name !== name))
  },
}))

/** 模型预设 "provider/modelId" → (provider, modelId)；空串 = 两者皆 null
 *  （pi 默认）。含 '/' 的 model id（HF 风格）不被此截断——indexOf 第一
 *  斜杠切分，provider 段不含 '/'（ComposerWired 审查 #1 同款边界）。
 *  无斜杠的非空值 = 形状非法，两者皆 null——调用方（BotsDialog）先做
 *  表单校验（非法值禁提交），这里不再兜底猜语义。 */
export function splitBotModel(model: string): {
  provider: string | null
  modelId: string | null
} {
  const trimmed = model.trim()
  if (!trimmed) return { provider: null, modelId: null }
  const idx = trimmed.indexOf('/')
  if (idx <= 0) return { provider: null, modelId: null }
  return { provider: trimmed.slice(0, idx), modelId: trimmed.slice(idx + 1) }
}
