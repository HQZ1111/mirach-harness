/**
 * 机器人花名册（左栏「机器人」窗格）——hermes plugins/hermes-bots 的
 * roster-pane 形制照抄（roster-pane-toolbar.tsx :72-120 段头 "Bots" +
 * 新建钮；bot-row.tsx :235-317 卡片 lead 头像方块 + 名称 + 细节行）。
 *
 * 数据面 = bots-store（本地 JSON，预设真相在宿主——bots-store 头注释
 * 论证）+ pi 多环境（启动 = pi_create_bot_session：system_prompt + model +
 * working_directory 一次性给足，pi_session.rs create_bot_session）。
 * 启动走 bot-launch（runtime 的既有重连通道重水合，runtime.tsx 不动）。
 *
 * hermes 逐项对照：
 * - 段头 "Bots" + 「新建」钮：roster-pane-toolbar.tsx :72-120（text 按钮
 *   icon-xs ghost）；Activity toasts 钮 pi 无承载（无后台 job 面板）——不造；
 * - 行（BotRow）：lead 方块（BotFace size=34 → --hub-avatar-size）+ 名称
 *   （0.8125rem medium）+ 细节行（model · cwd，tertiary/quaternary）；
 * - 行菜单（右键：编辑/删除，bot-row.tsx :319-462 的子集——harness 只收
 *   pi 承载得起的三项：启动/编辑/删除）；置顶/隐藏/分组/克隆/skills 管理
 *   等 pi 无对等承载的面不造 UI（宁缺毋滥，逐项注释）。
 *
 * 禁止 innerHTML；图标 = lucide-react 组件。
 */

import { useEffect, useState } from 'react'
import { BotIcon, PencilIcon, PlusIcon, TrashIcon } from 'lucide-react'

import { botsStore, useBotsStore, type BotPreset } from './hub/bots-store'
import { BotsDialog } from './hub/bots-dialog'
import { launchBotSession } from './hub/bot-launch'

type DialogState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; bot: BotPreset }

/** 机器人花名册窗格（bots pane）。 */
export function BotsPane() {
  const bots = useBotsStore((s) => s.bots)
  const [dialog, setDialog] = useState<DialogState>({ mode: 'closed' })
  const [launchError, setLaunchError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)

  // 挂载读存储（bots-store 的 load 时机：显式一次，layout-store 迁移先例）
  useEffect(() => {
    botsStore.getState().load()
  }, [])

  const launch = async (bot: BotPreset) => {
    setLaunchError(null)
    const ok = await launchBotSession(bot)
    if (!ok) {
      setLaunchError(`机器人「${bot.name}」会话启动失败——详见控制台。`)
    }
  }

  return (
    <div className="pane-placeholder">
      <h2>机器人花名册</h2>
      <p>每个机器人一份配置（system prompt / 模型 / 工作区）——启动即以该配置开新会话。</p>
      <div className="hub-bot-rows">
        <span className="hub-section-label">Bots</span>
        {bots.length === 0 && (
          <span className="set-file-missing">
            尚无机器人——点右上「+」新建一个预设。
          </span>
        )}
        {bots.map((bot) => (
          <div className="hub-bot-item" key={bot.name}>
            <button
              className="hub-bot-row"
              onClick={() => void launch(bot)}
              title={`启动「${bot.name}」会话`}
              type="button"
            >
              <span className="hub-bot-avatar" aria-hidden>
                <BotIcon size={18} />
              </span>
              <span className="hub-bot-main">
                <span className="hub-bot-name">{bot.name}</span>
                {bot.description && (
                  <span className="hub-bot-detail">{bot.description}</span>
                )}
                <span className="hub-bot-detail">
                  {[
                    bot.model || 'pi 默认模型',
                    bot.cwd || '进程工作区',
                  ].join(' · ')}
                </span>
              </span>
            </button>
            {/* 行操作簇（编辑/删除，hermes 行菜单右键子集的平铺等价——
                flexlayout 窗格内无 ContextMenu 体系，hover 显形的行内钮） */}
            <span className="hub-bot-actions" data-row-actions="">
              <button
                aria-label={`编辑 ${bot.name}`}
                className="hub-bot-btn"
                onClick={() => setDialog({ mode: 'edit', bot })}
                title="编辑"
                type="button"
              >
                <PencilIcon size={13} />
              </button>
              <button
                aria-label={`删除 ${bot.name}`}
                className={confirmDelete === bot.name ? 'hub-bot-btn hub-danger' : 'hub-bot-btn'}
                onClick={() => {
                  // 两步删除确认：第一次点变红（danger 态），第二次才真删
                  if (confirmDelete === bot.name) {
                    botsStore.getState().remove(bot.name)
                    setConfirmDelete(null)
                  } else {
                    setConfirmDelete(bot.name)
                  }
                }}
                onMouseLeave={() => {
                  if (confirmDelete === bot.name) setConfirmDelete(null)
                }}
                title={confirmDelete === bot.name ? '再次点击确认删除' : '删除'}
                type="button"
              >
                <TrashIcon size={13} />
              </button>
            </span>
          </div>
        ))}
      </div>
      {launchError && (
        <div className="set-err" role="alert">
          {launchError}
        </div>
      )}
      {/* 段头「新建」钮（roster-pane-toolbar 的 + 下拉的 Bot 项等价——
          group chat/section 等 pi 无承载项不造） */}
      <button
        className="hub-bot-new"
        onClick={() => setDialog({ mode: 'create' })}
        title="新建机器人"
        type="button"
      >
        <PlusIcon size={14} />
        新建机器人
      </button>
      <p className="hint">
        启动/编辑/删除已接真实数据面；hermes 的置顶/隐藏/分组/克隆/头像/
        skills 管理等面 pi 无对等承载（bot = 一份 SessionOptions 参数包）——
        不造假 UI。
      </p>
      {(dialog.mode === 'create' || dialog.mode === 'edit') && (
        <BotsDialog
          callbacks={{ launched: (bot) => void launch(bot) }}
          editing={dialog.mode === 'edit' ? dialog.bot : null}
          onClose={() => setDialog({ mode: 'closed' })}
        />
      )}
    </div>
  )
}
