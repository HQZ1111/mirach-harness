/**
 * mirach-pkg 插件：rpi 包登记表 UI（hermes 无 pkg 概念）。列表 = 全局原生
 * 扩展（native-packages.json）+ 项目包（.rpi/packages.json）的只读投影；
 * 安装/卸载/更新属于引擎侧 CLI（rpi install / uninstall / extension update）。
 */
import type { HarnessPlugin } from '../../contrib/types'
import { PkgManagerSection } from './pkg-manager'

const plugin: HarnessPlugin = {
  id: 'mirach-pkg',
  name: '包管理',
  description: 'rpi 包登记表（全局原生扩展 + 项目包）只读列表；安装/卸载/更新走引擎 CLI。',
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
