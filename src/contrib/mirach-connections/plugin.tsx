/**
 * mirach-connections 插件：连接注册表（hermes 多环境配置的宿主移植）。
 * 数据面 = pi_connections.rs IPC（local 真面 + remote/cloud/ssh 假面标红）。
 * 只保留 bots.roster.grouping 数据贡献——设置页的「连接」条目已按
 * 2026-11-24 用户要求删除（插件集成里不再出现核心/连接页）。
 */
import type { HarnessPlugin } from '../../contrib/types'

const plugin: HarnessPlugin = {
  id: 'mirach-connections',
  name: '多环境连接',
  description: '连接注册表（本机/远端/SSH/云）——机器人花名册按连接分组的数据源。',
  register: (ctx) => {
    ctx.register({
      id: 'roster-grouping',
      area: 'bots.roster.grouping',
      title: '按连接分组',
      data: { field: 'connectionId' },
    })
  },
}

export default plugin
