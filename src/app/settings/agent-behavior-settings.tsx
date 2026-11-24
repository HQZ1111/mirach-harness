/**
 * 设置页「行为与工具」节（2026-11-22，ZCode 设置页 `agentBehavior` 的移植；
 * ZCode 源码 = G:\ZCode-main packages/ui/src/settingsPageHelpers.tsx:792
 * `AgentBehaviorSectionContent` + settings/SettingsPageParts.tsx 的
 * SettingsGroupCard/SettingsRow 结构）。
 *
 * ZCode 的节在「Agent 能力」组下（settingsPageConfig.ts:91-96，导航图标
 * SlidersHorizontal），中文标题「行为与工具」（zh-CN.ts:3556）。宿主把节
 * 放进「Agent 控制」组、模型之后（组语义对应 ZCode 的 agentCapabilities）。
 *
 * **范围（2026-11-22 用户定稿："能接通的接通，不能的删除"）**：
 * ZCode 该节共 9 行；宿主保留能真实接通的 3 行，其余 6 行删除（不摆死开关）：
 *
 * 保留（全部真实生效）：
 * - 交互行为（队列 / 引导）：pi 引擎的 MessageDelivery::Steer / FollowUp
 *   原语（rpi-harness AgentLane::steer）——引导 = 注入当前 run，在下一次
 *   工具调用批后生效；队列 = 宿主队列，本轮结束后跟进（runtime.tsx onNew）。
 * - 显示思考过程：消息流展示全部思考；关闭时每轮保留第一条（ZCode
 *   messageStreamShowReasoning 同语义）。
 * - 显示待办：todo 工具卡片是否进消息流（ZCode messageStreamShowTodos）。
 *
 * 删除（宿主无数据面，逐个原因留档）：
 * - 工具搜索：pi 无工具搜索原语，恒发完整工具目录；
 * - 增强 Find 和 Grep：pi grep/find 固定进程内实现，无运行期开关；
 * - 提问自动继续：pi 提问/审批无超时自动继续（未回答一直等待）；
 * - 插件自动推荐：宿主无插件市场/推荐服务；
 * - 动态工作流：宿主无动态工作流引擎；
 * - 完整保留模型 I/O：pi 无该键（压缩配置在「记忆与上下文」节）。
 *
 * 文案：保留行的标题/说明逐字照抄 ZCode zh-CN.ts:3695-3705；「立即生效」
 * 说明是宿主补充的真实生效说明。
 */
import { type FC, type ReactNode } from 'react'

import { Switch } from '@/components/ui/switch'
import {
  conversationDisplayStore,
  useConversationDisplay,
} from '@/components/assistant-ui/conversation-display-store'

/** 行原语（与 settings-overlay 的 SetPrefRow 同构）。行独立成文件件避免
 *  settings-overlay ↔ 本节 的循环 import（overlay 是本节的上层消费者）。 */
const Row: FC<{
  label: string
  desc: string
  note?: ReactNode
  children: ReactNode
}> = ({ label, desc, note, children }) => (
  <div className="set-acct-field">
    {/* flex-basis 0：文字列按剩余宽度收缩，控件恒在同行右缘（ZCode 的
        [1fr_192px] 网格同语义）。basis auto 时文本的 max-content 会把
        控件挤到下一行（select 行实测换行、switch 行不换——不一致）。 */}
    <div className="set-acct-field-text" style={{ flex: '1 1 0' }}>
      <span className="set-acct-field-label">{label}</span>
      <p className="set-acct-field-desc">{desc}</p>
      {note !== undefined && (
        <p className="set-acct-field-desc" style={{ marginTop: 4 }}>
          {note}
        </p>
      )}
    </div>
    <div className="set-acct-field-control">{children}</div>
  </div>
)

export const AgentBehaviorSettings: FC = () => {
  const showReasoning = useConversationDisplay((s) => s.showReasoning)
  const showTodos = useConversationDisplay((s) => s.showTodos)
  const interactionBehavior = useConversationDisplay((s) => s.interactionBehavior)

  return (
    <section className="set-section">
      <div className="set-acct-card">
        <div className="set-acct-card-body">
          <Row
            label="交互行为"
            desc="在 ZCode 运行时将后续操作加入队列，或引导至下一轮工具调用后运行。"
            note="立即生效：队列 = 等本轮结束后的下一条消息跟进；引导 = 注入当前轮，在下一次工具调用后生效（仅对正在运行的轮次有效）。"
          >
            <select
              aria-label="交互行为"
              className="set-select"
              onChange={(e) => {
                const next = e.target.value === 'guide' ? 'guide' : 'queue'
                conversationDisplayStore.getState().setInteractionBehavior(next)
              }}
              value={interactionBehavior}
            >
              <option value="queue">队列</option>
              <option value="guide">引导</option>
            </select>
          </Row>
          <Row
            label="显示思考过程"
            desc="在消息流中展示完整的模型思考内容；关闭时每轮仍展示第一次思考。"
            note="立即生效：关闭后每轮只保留第一条非空思考，其余从消息流中剔除。"
          >
            <Switch
              aria-label="显示思考过程"
              checked={showReasoning}
              onCheckedChange={(checked) =>
                conversationDisplayStore.getState().setShowReasoning(checked)
              }
            />
          </Row>
          <Row
            label="显示待办"
            desc="在消息流中展示 Todo 工具卡片。"
            note="立即生效：打开后 todo 工具卡片进消息流；状态面板的待办分区仍保留。"
          >
            <Switch
              aria-label="显示待办"
              checked={showTodos}
              onCheckedChange={(checked) =>
                conversationDisplayStore.getState().setShowTodos(checked)
              }
            />
          </Row>
        </div>
      </div>
    </section>
  )
}
