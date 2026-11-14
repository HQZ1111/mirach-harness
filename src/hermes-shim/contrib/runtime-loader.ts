/**
 * @/contrib/runtime-loader shim - the desktop plugin JS runtime.
 *
 * Upstream 1,120 lines: scans the app plugin root, rewrites import specifiers,
 * evaluates plugin.js in a sandboxed module context, calls the plugin register()
 * against the plugin SDK, and watches the file for reloads.
 *
 * Host: no renderer plugin runtime - pi extensions run in the agent, not here.
 * Both exports report the true state: a scan finds nothing (nothing to watch),
 * and an uninstall has nothing to remove. The Plugins tab desktop column renders
 * from the plugins store, which stays empty.
 */

export async function discoverRuntimePlugins(): Promise<void> {
  // No plugin root, no runtime, no plugins. The mirrored callers await this
  // before (re)reading the plugin records; an immediate resolve is the truth.
}

export async function uninstallDiskPlugin(pluginId: string): Promise<{ error?: string; ok: boolean }> {
  return { error: '本宿主没有桌面插件运行时，无法卸载 ' + pluginId, ok: false }
}
