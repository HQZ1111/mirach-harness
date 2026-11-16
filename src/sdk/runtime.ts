/**
 * Runtime SDK injection — hermes `sdk/runtime.ts` 的宿主对偶。
 *
 * Bundled 插件通过 vite alias 解析 `@hermes/plugin-sdk`；**运行时加载**的磁盘
 * 插件（热拔插）import 同一个 specifier，由 loader 重写成这里生成的 blob shim
 * URL——shim 从 `globalThis.__HERMES_PLUGIN_SDK__` 等命名空间 re-export 活对象。
 * React 必须复用宿主单例，第二个实例会让 hooks 直接炸。
 *
 * 与上游的两处差异（都是宿主稳定性要求）：
 * 1. SDK barrel 用 **动态 import**：`sdk/index` 会拖入 hermes-mirror 组件树，
 *    其中任何一个未解析的 hermes 内部别名都会让静态 import 直接把整页打白。
 *    动态加载后失败只影响插件（loader 报 error 记录），壳不受影响。
 * 2. 命名空间在 install 时才读取（同上游的惰性理由：import 环）。
 */

import * as React from 'react'
import * as jsxDevRuntime from 'react/jsx-dev-runtime'
import * as jsxRuntime from 'react/jsx-runtime'

type SdkNamespace = Record<string, unknown>

interface Namespaces {
  __HERMES_PLUGIN_SDK__: SdkNamespace
  __HERMES_REACT__: SdkNamespace
  __HERMES_REACT_JSX__: SdkNamespace
  __HERMES_REACT_JSX_DEV__: SdkNamespace
}

let installed: Namespaces | null = null
let cachedMap: Record<string, string> | null = null

function namespaces(sdk: SdkNamespace): Namespaces {
  return {
    __HERMES_PLUGIN_SDK__: sdk,
    __HERMES_REACT__: React as unknown as SdkNamespace,
    __HERMES_REACT_JSX__: jsxRuntime as unknown as SdkNamespace,
    __HERMES_REACT_JSX_DEV__: jsxDevRuntime as unknown as SdkNamespace,
  }
}

/** Install the live namespaces the blob shims re-export. Call once at boot. */
export async function installPluginSdk(): Promise<void> {
  if (!installed) {
    // Dynamic: a broken SDK barrel must not white-screen the app shell.
    const sdk = (await import('./index')) as unknown as SdkNamespace
    installed = namespaces(sdk)
    Object.assign(globalThis, installed)
    cachedMap = null
  }
}

/** Build a shim ESM blob that re-exports a global namespace's live members. */
function shimUrl(globalKey: keyof Namespaces): string {
  const ns = installed
  if (!ns) throw new Error('[plugins] SDK 未安装：先调用 installPluginSdk()')
  const names = Object.keys(ns[globalKey]).filter(
    (name) => name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name),
  )
  const source =
    `const m = globalThis.${globalKey};\n` +
    `export default m.default ?? m;\n` +
    (names.length ? `export const { ${names.join(', ')} } = m;\n` : '')
  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
}

/** Specifier → shim URL map for the runtime loader. */
export function sdkImportMap(): Record<string, string> {
  if (!installed) throw new Error('[plugins] SDK 未安装：先调用 installPluginSdk()')
  cachedMap ??= {
    '@hermes/plugin-sdk': shimUrl('__HERMES_PLUGIN_SDK__'),
    'react/jsx-dev-runtime': shimUrl('__HERMES_REACT_JSX_DEV__'),
    'react/jsx-runtime': shimUrl('__HERMES_REACT_JSX__'),
    react: shimUrl('__HERMES_REACT__'),
  }
  return cachedMap
}
