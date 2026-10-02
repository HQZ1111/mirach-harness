/**
 * pi 模型目录共享投影（composer-wired 的模型触发器与 thread 消息 footer
 * 的 regenerate-menu「换模型重生成」共用）：pi_list_models 目录 + 当前
 * 选中模型（pi_get_state 回读 / pi_set_model 成功后写）。目录拉取带进程内
 * 缓存（成功后不再重复拉，失败可重试）；当前选中模型是单源——写入方
 * （composer-wired 的 pi_get_state effect / onModelChange、runtime 的
 * onReload modelOverride 路径）都落到这里，消费方各自订阅。
 *
 * zustand vanilla 模式，照抄 connection-store / approval-bridge。
 */
import { invoke } from '@tauri-apps/api/core'
import { createStore, useStore } from 'zustand'

import type { ModelOption } from './model-selector.aui'

/** pi 模型目录条目（pi_list_models 返回形状，原 composer-wired 定义上移） */
export interface PiModelEntry {
  provider: string
  id: string
  name: string
  reasoning: boolean
  contextWindow: number
}

/** pi 模型目录 → ModelSelector 选项；reasoning 模型带默认三档
 * （原 composer-wired 投影上移，逐行为保持不变） */
export function toModelOptions(entries: PiModelEntry[]): ModelOption[] {
  return entries.map((e) => ({
    id: `${e.provider}/${e.id}`,
    name: e.name || e.id,
    description: e.provider,
    ...(e.reasoning ? { efforts: true as const } : {}),
  }))
}

interface ModelCatalogState {
  entries: PiModelEntry[]
  /** 目录拉取缓存：成功后保持 resolved promise（不重复拉）；失败清空可重试 */
  loadPromise: Promise<void> | null
  load: () => Promise<void>
  /** 当前选中模型（provider/modelId）；null = 未知（首条消息前无会话） */
  currentModel: string | null
  setCurrentModel: (model: string | null) => void
}

export const modelCatalogStore = createStore<ModelCatalogState>((set, get) => ({
  entries: [],
  loadPromise: null,
  load: () => {
    const existing = get().loadPromise
    if (existing) return existing
    const p = invoke<{ models: PiModelEntry[] }>('pi_list_models')
      .then((res) => {
        set({ entries: res.models ?? [] })
      })
      .catch((e) => {
        console.error('[pi] 模型目录获取失败', e)
        // 失败清缓存：下次 load 可重试（错误已可见，不静默吞）
        set({ loadPromise: null })
      })
    set({ loadPromise: p })
    return p
  },
  currentModel: null,
  setCurrentModel: (model) => set({ currentModel: model }),
}))

export function useModelCatalog(): ModelCatalogState
export function useModelCatalog<T>(selector: (s: ModelCatalogState) => T): T
export function useModelCatalog(selector?: (s: ModelCatalogState) => unknown): unknown {
  return useStore(modelCatalogStore, selector ?? ((s) => s))
}
