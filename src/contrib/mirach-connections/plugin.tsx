/**
 * mirach-connections 插件：连接注册表（hermes 多环境配置的宿主移植）。
 * 数据面 = pi_connections.rs IPC（local 真面 + remote/cloud/ssh 假面标红）。
 * UI = settings.page 贡献（注册表页）+ bots.roster.grouping 数据贡献。
 */
import type { HarnessPlugin } from '../../contrib/types'
import { ConnectionsRegistrySection } from './connections-registry'

const plugin: HarnessPlugin = {
  id: 'mirach-connections',
  name: '多环境连接',
  description: '连接注册表（本机/远端/SSH/云）——机器人花名册按连接分组的数据源。',
  register: (ctx) => {
    ctx.register({
      id: 'settings-page',
      area: 'settings.page',
      title: '连接',
      order: 45,
      render: () => <ConnectionsRegistrySection />,
    })
    ctx.register({
      id: 'roster-grouping',
      area: 'bots.roster.grouping',
      title: '按连接分组',
      data: { field: 'connectionId' },
    })
  },
}

export default plugin
