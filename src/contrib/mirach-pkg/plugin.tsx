/**
 * mirach-pkg 插件：pi 包管理 UI（PackageManager 的宿主对偶——hermes 无
 * pkg 概念，此面为 pi install/remove/update/list 的图形化，全真实数据）。
 */
import type { HarnessPlugin } from '../../contrib/types'
import { PkgManagerSection } from './pkg-manager'

const plugin: HarnessPlugin = {
  id: 'mirach-pkg',
  name: '包管理',
  description: 'pi 包管理（install/remove/update/list）——包向会话贡献 extensions/skills/prompts/themes。',
  register: (ctx) => {
    ctx.register({
      id: 'settings-page',
      area: 'settings.page',
      title: '包',
      order: 46,
      render: () => <PkgManagerSection />,
    })
  },
}

export default plugin
