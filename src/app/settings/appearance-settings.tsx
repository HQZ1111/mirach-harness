/**
 * 设置 →「外观」（2026-11-23）。
 *
 * 结构、文案、预览与交互全部照 hermes
 * `apps/desktop/src/app/settings/appearance-settings.tsx`：
 *   - 主题：明亮 / 暗色 / 跟随系统（hermes `MODE_OPTIONS`）+ 皮肤画廊
 *   - 开场标识（空对话的字标与提示语）
 *   - 界面缩放 / 聊天文字大小 / 聊天字体 / 终端字体
 *   - 窗口透明（Tauri `transparent: true` + Acrylic/Clear 桥已接通）
 *   - 聊天背景（单层总背景；内置图片切换 / 自定义上传） / 文件浏览器
 *   - 消息气泡
 *
 * 数据面：主题走镜像 `ThemeProvider`；其余走 `lib/appearance-prefs.ts`
 * （localStorage，跨窗口生效）。文件浏览器镜像主窗 dockview 面板 `files`。
 */
import { Check, Image as ImageIcon, Monitor, Moon, RotateCcw, Sun, Upload } from 'lucide-react'
import { useStore as useNanoStore } from '@nanostores/react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { useStore } from 'zustand'

import {
  $translucency,
  GLASS_SCOPES,
  GLASS_IS_WINDOWS,
  GLASS_SUPPORTED,
  glassMaterialForPicker,
  glassMaterialsFor,
  setTranslucency,
  setTranslucencyFade,
  setTranslucencyMaterial,
  setTranslucencyMode,
  setTranslucencyScope,
  TRANSLUCENCY_SUPPORTED,
} from '@/hermes-shim/store/translucency'

import {
  ACCENT_SWATCHES,
  appearanceStore,
  BUILTIN_BACKDROPS,
  CHAT_FONT_SUGGESTIONS,
  CHAT_TEXT_SCALE_PRESETS,
  isBuiltinBackdrop,
  TERMINAL_FONT_SUGGESTIONS,
  UI_SCALE_PRESETS,
} from '@/lib/appearance-prefs'
import { readFileBrowserOpen, subscribeFileBrowser, writeFileBrowserOpen } from '@/lib/file-browser-pref'
import { getBaseColors, HOST_THEME_NONE, useTheme } from '@/hermes-mirror/themes/context'
import { DEFAULT_SKIN_NAME } from '@/hermes-mirror/themes/presets'
import { resolveChatFontFamily } from '@/hermes-mirror/themes/chat-font'
import { cn } from '@/lib/utils'
import { SearchField } from '@/components/ui/search-field'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { Slider } from '@/components/ui/slider'

import { ComboboxInput } from './combobox-input'
import { ListRow, ToggleRow } from './primitives'

function ThemePreview({ mode, name }: { mode: 'light' | 'dark'; name: string }) {
  const c = getBaseColors(name, mode)

  return (
    <div
      className="h-20 overflow-hidden rounded-xl border shadow-xs"
      style={{ backgroundColor: c.background, borderColor: c.border }}
    >
      <div className="flex h-full">
        <div
          className="w-12 border-r"
          style={{
            backgroundColor: c.sidebarBackground ?? c.muted,
            borderColor: c.sidebarBorder ?? c.border,
          }}
        />
        <div className="flex flex-1 flex-col gap-2 p-3">
          <div className="h-2.5 w-16 rounded-full" style={{ backgroundColor: c.foreground }} />
          <div className="h-2 w-24 rounded-full" style={{ backgroundColor: c.mutedForeground }} />
          <div className="mt-auto flex justify-end">
            <div
              className="h-5 w-16 rounded-full border"
              style={{
                backgroundColor: c.userBubble ?? c.muted,
                borderColor: c.userBubbleBorder ?? c.border,
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

const MODE_OPTIONS = [
  { id: 'light' as const, label: '明亮', icon: Sun },
  { id: 'dark' as const, label: '暗色', icon: Moon },
  { id: 'system' as const, label: '跟随系统', icon: Monitor },
]

const DEFAULT_MODE = 'light' as const

/** 主题名/描述中文化（2026-11-24 用户："下面的主题改成中文显示"）。未知的
 * 用户主题保留原名，不伪造翻译。 */
const THEME_ZH: Record<string, { label: string; description: string }> = {
  nous: { label: '默认', description: 'GitHub 灰壳，Nous 蓝强调色' },
  github: { label: 'GitHub', description: 'GitHub 明亮 / 暗色默认配色' },
  catppuccin: { label: '卡布奇诺', description: '柔和粉彩——拿铁与摩卡' },
  everforest: { label: '常绿森林', description: '温暖低对比的森林绿' },
  solarized: { label: '日光', description: '固定对比度的明暗双色' },
  'nous-alt': { label: 'Nous 玻璃', description: '玻璃中性色，奶油字配任务蓝' },
  classic: { label: '经典 Hermes', description: '海军蓝底配金色，CLI 最初的样子' },
  midnight: { label: '午夜', description: '深蓝紫与冷色强调' },
  ember: { label: '余烬', description: '暖绯红与青铜，锻造感' },
  mono: { label: '极简黑白', description: '干净灰阶，专注无干扰' },
  cyberpunk: { label: '赛博朋克', description: '黑底霓虹绿，矩阵终端感' },
  slate: { label: '石板蓝', description: '冷调石板蓝，开发者主题' },
}

function themeLabel(theme: { name: string; label: string }): string {
  return THEME_ZH[theme.name]?.label ?? theme.label
}

function themeDescription(theme: { name: string; description: string }): string {
  return THEME_ZH[theme.name]?.description ?? theme.description
}

function ColorSwatchPicker({
  label,
  onChange,
  value,
}: {
  label: string
  onChange: (value: string) => void
  value: string
}) {
  const custom = value !== '' && !(ACCENT_SWATCHES as readonly string[]).includes(value)
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        aria-label={`${label}：默认（跟随主题）`}
        aria-pressed={!value}
        className={cn(
          'rounded-md border px-2.5 py-1.5 text-xs transition-colors',
          !value
            ? 'border-(--brand) text-(--brand)'
            : 'border-(--stroke-soft) text-(--ui-text-secondary) hover:border-(--stroke)',
        )}
        onClick={() => onChange('')}
        type="button"
      >
        默认
      </button>
      {ACCENT_SWATCHES.map((swatch) => (
        <button
          aria-label={`${label} ${swatch}`}
          aria-pressed={value === swatch}
          className={cn(
            'relative grid size-7 place-items-center rounded-full border-2 transition-transform hover:scale-110',
            value === swatch ? 'border-foreground' : 'border-transparent',
          )}
          key={swatch}
          onClick={() => onChange(value === swatch ? '' : swatch)}
          style={{ backgroundColor: swatch }}
          type="button"
        >
          {value === swatch && <Check className="size-3.5 text-white drop-shadow" />}
        </button>
      ))}
      <label
        aria-label={`${label}：自定义`}
        className={cn(
          'relative grid size-7 cursor-pointer place-items-center overflow-hidden rounded-full border-2',
          custom ? 'border-foreground' : 'border-(--stroke-soft) border-dashed',
        )}
        style={custom ? { backgroundColor: value } : undefined}
      >
        <input
          aria-label={`${label}自定义`}
          className="absolute inset-0 cursor-pointer opacity-0"
          onChange={(event) => onChange(event.target.value)}
          type="color"
          value={custom ? value : '#006fff'}
        />
        {custom ? (
          <Check className="size-3.5 text-white drop-shadow" />
        ) : (
          <span className="text-[10px] text-(--ui-text-tertiary)">+</span>
        )}
      </label>
    </div>
  )
}

/** 外观页的岛式分组：一行/多行设置放进同一张圆角白卡，卡内用分隔线。 */
function CardGroup({ children }: { children: ReactNode }) {
  return (
    <div className="set-acct-card">
      <div className="set-acct-card-body">{children}</div>
    </div>
  )
}

export function AppearanceSettings() {
  const { themeName, mode, resolvedMode, availableThemes, setTheme, setMode } = useTheme()
  const prefs = useStore(appearanceStore)
  const translucency = useNanoStore($translucency)
  const [query, setQuery] = useState('')
  const [fileBrowserOpen, setFileBrowserOpen] = useState(readFileBrowserOpen)

  useEffect(() => subscribeFileBrowser(setFileBrowserOpen), [])

  const filteredThemes = useMemo(() => {
    const needle = query.trim().toLowerCase()
    // 保持主题注册表的固定顺序：选中项不置顶（2026-11-24 用户："现在
    // 选项一个主题，会跑到第一个选项那里，位置不要动"）。选中态只用
    // 边框/底色表达，点击已选主题再取消回默认。
    // nous 是旧的「默认」皮肤，不再作为可选主题出现；无主题状态不占卡片。
    return availableThemes
      .filter((theme) => theme.name !== DEFAULT_SKIN_NAME)
      .filter(
        (theme) =>
          !needle ||
          themeLabel(theme).toLowerCase().includes(needle) ||
          theme.label.toLowerCase().includes(needle) ||
          theme.name.toLowerCase().includes(needle) ||
          themeDescription(theme).toLowerCase().includes(needle) ||
          theme.description.toLowerCase().includes(needle),
      )
  }, [availableThemes, query])

  const builtinBackdrop = isBuiltinBackdrop(prefs.backdropImage)
  const currentBuiltin =
    BUILTIN_BACKDROPS.find((item) => item.path === prefs.backdropImage) ?? BUILTIN_BACKDROPS[0]

  const chooseCustomBackdrop = () => {
    void openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif'] }],
    })
      .then((path) => {
        if (typeof path === 'string' && path) {
          prefs.setBackdropImage(path)
          prefs.setBackdrop(true)
        }
      })
      .catch((e) => console.error('[appearance] 选择背景图失败', e))
  }

  return (
    <div className="flex flex-col gap-4">
      <CardGroup>
      <ListRow
        below={
          <>
            {/* 明亮 / 暗色是默认主题；控件放大后独占一排（用户："选择切换的
                组件放大，单独一排"）。再次点击已选模式 = 回到默认的明亮。 */}
            <div className="mt-3 grid w-full grid-cols-3 gap-2">
              {MODE_OPTIONS.map(({ id, label, icon: Icon }) => {
                const active = mode === id
                return (
                  <button
                    aria-pressed={active}
                    className={cn(
                      'relative flex min-h-14 w-full items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-medium transition-colors',
                      active
                        ? 'border-(--brand) bg-(--select-wash) text-foreground'
                        : 'border-(--stroke-soft) text-(--ui-text-secondary) hover:bg-(--hover-wash) hover:text-foreground',
                    )}
                    key={id}
                    onClick={() => setMode(active && id !== DEFAULT_MODE ? DEFAULT_MODE : id)}
                    type="button"
                  >
                    <Icon className="size-[var(--size-icon-md)]" />
                    <span>{label}</span>
                    {active && <Check className="absolute top-2 right-2 size-3.5 text-(--brand)" />}
                  </button>
                )
              })}
            </div>
            <SearchField
              containerClassName="mt-3 w-full"
              inputClassName="flex-1"
              onChange={setQuery}
              placeholder="搜索主题…"
              value={query}
              variant="box"
            />
            {/* 完整显示整个画廊：不再用 max-h-96 切成内层滚动区（用户：
                "主题的显示被截断了，需要滚动，改成完整显示"）。设置页本身
                滚动。 */}
            <div className="mt-3">
              {filteredThemes.length === 0 ? (
                <p className="text-[length:var(--settings-desc-size)] text-(--ui-text-tertiary)">
                  没有匹配「{query.trim()}」的已安装主题。
                </p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                  {filteredThemes.map((theme) => {
                    const active = themeName === theme.name
                    return (
                      <button
                        className={cn(
                          'w-full rounded-lg border p-2 text-left transition-colors',
                          active
                            ? 'border-(--brand) bg-(--ui-bg-tertiary)'
                            : 'border-(--stroke-soft) hover:border-(--stroke)',
                        )}
                        key={theme.name}
                        onClick={() => setTheme(active ? HOST_THEME_NONE : theme.name)}
                        type="button"
                      >
                        <ThemePreview mode={resolvedMode} name={theme.name} />
                        <div className="mt-3 px-1">
                          <div className="truncate text-[length:var(--settings-label-size)] font-medium">
                            {themeLabel(theme)}
                          </div>
                          <div className="mt-0.5 line-clamp-2 text-[length:var(--settings-desc-size)] leading-[1.5] text-(--ui-text-tertiary)">
                            {themeDescription(theme)}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </>
        }
        description="明亮 / 暗色是宿主基础明暗；选择主题后叠加其调色板。已选主题再点一次取消主题，恢复无主题外观。"
        title="主题"
        wide
      />
      </CardGroup>

      <CardGroup>
      <ListRow
        action={
          <ColorSwatchPicker
            label="主题色"
            onChange={prefs.setAccentColor}
            value={prefs.accentColor}
          />
        }
        description="应用于 logo、蓝色文字、选中高亮与发送按钮。默认 = 跟随当前主题；已选颜色再点一次也回到默认。"
        title="主题色"
      />

      {/* 文字颜色在主题色下面（2026-11-24 用户），同样 6 个预设 + 自定义 +
          默认。只覆盖主文字层级，副标题/弱化文字仍由主题控制。 */}
      <ListRow
        action={
          <ColorSwatchPicker
            label="文字颜色"
            onChange={prefs.setTextColor}
            value={prefs.textColor}
          />
        }
        description="主文字、标题和页签文字的颜色。默认 = 跟随当前主题；已选颜色再点一次也回到默认。"
        title="文字颜色"
      />

      </CardGroup>

      <CardGroup>
      <ListRow
        action={
          <SegmentedControl
            onChange={(value) => {
              const next = Number(value)
              // 再点已选档位 = 恢复默认 100%。
              prefs.setUiScale(next === prefs.uiScale ? 100 : next)
            }}
            options={UI_SCALE_PRESETS.map((preset) => ({ id: String(preset), label: `${preset}%` }))}
            value={String(prefs.uiScale)}
          />
        }
        description={`缩放整个应用的文字和界面。也可使用 Cmd/Ctrl 加 +、- 或 0 调整。当前：${prefs.uiScale}%`}
        title="界面缩放"
      />

      <ListRow
        action={
          <SegmentedControl
            onChange={(value) => {
              const next = Number(value)
              // 再点已选档位 = 恢复默认 100%（用户："默认值 110% 不对，
              // 都从 100% 开始显示，好恢复默认值"）。
              prefs.setChatTextScale(next === prefs.chatTextScale ? 100 : next)
            }}
            options={CHAT_TEXT_SCALE_PRESETS.map((preset) => ({ id: String(preset), label: `${preset}%` }))}
            value={String(prefs.chatTextScale)}
          />
        }
        description="相对于界面缩放调整对话文字和消息输入框的字号。侧边栏和控件大小保持不变。"
        title="聊天文字大小"
      />

      <ListRow
        below={
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-3">
              <ComboboxInput
                aria-label="聊天字体"
                className="flex-1"
                onChange={prefs.setChatFont}
                options={CHAT_FONT_SUGGESTIONS}
                placeholder="OpenDyslexic 或 CSS 字体栈"
                renderOption={(font) => (
                  <span style={{ fontFamily: resolveChatFontFamily(font, 'var(--font-family-default)') }}>{font}</span>
                )}
                value={prefs.chatFont}
              />
              <button
                className="text-(--ui-text-tertiary) text-xs hover:text-foreground disabled:opacity-50"
                disabled={!prefs.chatFont}
                onClick={() => prefs.setChatFont('')}
                type="button"
              >
                使用主题字体
              </button>
            </div>
            <div className="overflow-hidden px-1 py-2 text-sm text-(--ui-text-secondary)">
              <span className="mr-2 text-[length:var(--settings-desc-size)] text-(--ui-text-tertiary)">
                预览
              </span>
              <span>敏捷的棕色狐狸跳过了懒狗。 0123456789</span>
            </div>
          </div>
        }
        description="为聊天及应用界面选择已安装的字体，适合 OpenDyslexic 等易读字体；留空则使用主题字体。"
        title="聊天字体"
        wide
      />

      <ListRow
        below={
          <div className="mt-3 space-y-2">
            <div className="flex items-center gap-3">
              <ComboboxInput
                aria-label="终端字体"
                className="flex-1"
                onChange={prefs.setTerminalFont}
                options={TERMINAL_FONT_SUGGESTIONS}
                placeholder="MesloLGS NF 或 CSS 字体栈"
                renderOption={(font) => <span style={{ fontFamily: font }}>{font}</span>}
                value={prefs.terminalFont}
              />
              <button
                className="text-(--ui-text-tertiary) text-xs hover:text-foreground disabled:opacity-50"
                disabled={!prefs.terminalFont}
                onClick={() => prefs.setTerminalFont('')}
                type="button"
              >
                使用默认字体
              </button>
            </div>
            <div
              className="overflow-hidden px-1 py-2 text-sm text-(--ui-text-secondary)"
              style={{ fontFamily: prefs.terminalFont || undefined }}
            >
              <span className="mr-2 text-[length:var(--settings-desc-size)] text-(--ui-text-tertiary)">
                字形预览
              </span>
              <span>~/project git:main ❯</span>
            </div>
          </div>
        }
        description="选择已安装的字体用于桌面端终端。Nerd Font 可正确显示 Powerlevel10k 和 Shell 图标；留空则使用内置的 JetBrains Mono。"
        title="终端字体"
        wide
      />
      </CardGroup>

      <CardGroup>
      <ToggleRow
        checked={fileBrowserOpen}
        description="打开工作区时，在聊天旁显示文件浏览器。标题栏的切换按钮也会更改此设置。"
        label="文件浏览器"
        onChange={(open) => {
          setFileBrowserOpen(open)
          writeFileBrowserOpen(open)
        }}
      />

      {TRANSLUCENCY_SUPPORTED && (
        <ListRow
          action={
            <div className="flex items-center gap-3">
              {GLASS_SUPPORTED && (
                <SegmentedControl
                  onChange={setTranslucencyMode}
                  options={[
                    { id: 'clear' as const, label: '透明' },
                    { id: 'glass' as const, label: '玻璃' },
                  ]}
                  value={translucency.mode}
                />
              )}
              {translucency.mode !== 'glass' && (
                <div className="flex items-center gap-2">
                  <Slider
                    aria-label="窗口透明"
                    max={100}
                    min={0}
                    onChange={(event) => setTranslucency(Number(event.target.value))}
                    step={1}
                    value={translucency.intensity}
                  />
                  <span className="w-9 text-right text-[length:var(--settings-desc-size)] tabular-nums text-(--ui-text-tertiary)">
                    {translucency.intensity}%
                  </span>
                </div>
              )}
            </div>
          }
          below={
            translucency.mode === 'glass' ? (
              <div className="mt-3 flex flex-col gap-2.5">
                <div className="flex items-center gap-3">
                  <span className="w-12 text-[length:var(--settings-desc-size)] text-(--ui-text-tertiary)">
                    色调
                  </span>
                  <Slider
                    aria-label="色调"
                    max={100}
                    min={0}
                    onChange={(event) => setTranslucency(Number(event.target.value))}
                    step={1}
                    value={translucency.intensity}
                  />
                  <span className="w-9 text-right text-[length:var(--settings-desc-size)] tabular-nums text-(--ui-text-tertiary)">
                    {translucency.intensity}%
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="w-12 text-[length:var(--settings-desc-size)] text-(--ui-text-tertiary)">
                    淡出
                  </span>
                  <Slider
                    aria-label="淡出"
                    max={100}
                    min={0}
                    onChange={(event) => setTranslucencyFade(Number(event.target.value))}
                    step={1}
                    value={translucency.fade}
                  />
                  <span className="w-9 text-right text-[length:var(--settings-desc-size)] tabular-nums text-(--ui-text-tertiary)">
                    {translucency.fade}%
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="w-12 text-[length:var(--settings-desc-size)] text-(--ui-text-tertiary)">
                    磨砂质感
                  </span>
                  <SegmentedControl
                    onChange={setTranslucencyMaterial}
                    options={glassMaterialsFor(GLASS_IS_WINDOWS).map((material) => ({
                      id: material,
                      label:
                        { 'under-window': '柔和', popover: '深邃', tabbed: '深邃', mica: '明亮', header: '明亮', titlebar: '明亮', sidebar: '明亮' }[
                          material
                        ] ?? material,
                    }))}
                    value={glassMaterialForPicker(translucency.material, GLASS_IS_WINDOWS)}
                  />
                </div>
                <div className="flex items-center gap-3">
                  <span className="w-12 text-[length:var(--settings-desc-size)] text-(--ui-text-tertiary)">
                    适用范围
                  </span>
                  <SegmentedControl
                    onChange={setTranslucencyScope}
                    options={GLASS_SCOPES.map((scope) => ({
                      id: scope,
                      label: scope === 'window' ? '整个窗口' : '仅侧栏',
                    }))}
                    value={translucency.scope}
                  />
                </div>
              </div>
            ) : undefined
          }
          description={
            translucency.mode === 'glass'
              ? '磨砂玻璃：桌面以柔和模糊透出，文字保持清晰。'
              : '让桌面透过整个窗口；Clear 会把窗口整体淡出。'
          }
          title="窗口透明"
        />
      )}
      </CardGroup>

      <CardGroup>
      <ToggleRow
        checked={prefs.introSplash}
        description="空白对话中显示的字标和提示语。"
        label="开场标识"
        onChange={prefs.setIntroSplash}
      />

      <ToggleRow
        checked={prefs.bottomWave}
        description="软件底部向上的一层弧形波浪渐变，颜色跟随主题色。"
        label="底部动效"
        onChange={prefs.setBottomWave}
      />

      <ToggleRow
        below={
          prefs.backdrop ? (
            <div className="mt-3 space-y-3">
              {/* 只有两个来源：内置图片切换 / 自定义上传（用户定稿）。 */}
              <div className="grid gap-2 sm:grid-cols-2">
                <button
                  aria-pressed={builtinBackdrop}
                  className={cn(
                    'relative flex min-h-14 items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors',
                    builtinBackdrop
                      ? 'border-(--brand) bg-(--select-wash)'
                      : 'border-(--stroke-soft) hover:bg-(--hover-wash)',
                  )}
                  onClick={() => {
                    if (!builtinBackdrop) prefs.setBackdropImage(BUILTIN_BACKDROPS[0].path)
                    prefs.setBackdrop(true)
                  }}
                  type="button"
                >
                  <ImageIcon className="size-[var(--size-icon-lg)] shrink-0 text-(--brand)" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">内置图片</span>
                    <span className="mt-0.5 block text-[length:var(--settings-desc-size)] text-(--ui-text-tertiary)">
                      在随应用附带的壁纸间切换
                    </span>
                  </span>
                  {builtinBackdrop && <Check className="absolute top-2 right-2 size-3.5 text-(--brand)" />}
                </button>
                <button
                  aria-pressed={!builtinBackdrop}
                  className={cn(
                    'relative flex min-h-14 items-center gap-3 rounded-xl border px-3 py-3 text-left transition-colors',
                    !builtinBackdrop
                      ? 'border-(--brand) bg-(--select-wash)'
                      : 'border-(--stroke-soft) hover:bg-(--hover-wash)',
                  )}
                  onClick={chooseCustomBackdrop}
                  type="button"
                >
                  <Upload className="size-[var(--size-icon-lg)] shrink-0 text-(--brand)" />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">自定义上传</span>
                    <span className="mt-0.5 block text-[length:var(--settings-desc-size)] text-(--ui-text-tertiary)">
                      从本机选择一张图片
                    </span>
                  </span>
                  {!builtinBackdrop && <Check className="absolute top-2 right-2 size-3.5 text-(--brand)" />}
                </button>
              </div>

              {/* 之前的 5/15/30/50/100 透明度档位（用户 2026-11-24："加回来"）：
                  控制每栏容器保留多少实色，档位越高背景图越明显。 */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[length:var(--settings-desc-size)] text-(--ui-text-tertiary)">
                  透明度
                </span>
                <SegmentedControl
                  onChange={(value) => prefs.setBackdropOpacity(Number(value))}
                  options={[5, 15, 30, 50, 100].map((value) => ({ id: String(value), label: `${value}%` }))}
                  value={String(prefs.backdropOpacity)}
                />
              </div>

              {builtinBackdrop ? (
                <div>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {BUILTIN_BACKDROPS.map((item) => {
                      const active = prefs.backdropImage === item.path
                      return (
                        <button
                          aria-label={item.label}
                          aria-pressed={active}
                          className={cn(
                            'relative h-20 w-28 shrink-0 overflow-hidden rounded-lg border-2 transition-colors',
                            active
                              ? 'border-(--brand)'
                              : 'border-transparent hover:border-(--stroke)',
                          )}
                          key={item.path}
                          onClick={() => {
                            // 再点当前图 = 回到第一张内置图（默认）。
                            prefs.setBackdropImage(
                              active ? BUILTIN_BACKDROPS[0].path : item.path,
                            )
                            prefs.setBackdrop(true)
                          }}
                          title={item.label}
                          type="button"
                        >
                          <img alt="" className="h-full w-full object-cover" loading="lazy" src={item.path} />
                          {active && (
                            <span className="absolute right-1 bottom-1 grid size-5 place-items-center rounded-full bg-(--brand) text-(--on-brand)">
                              <Check className="size-3" />
                            </span>
                          )}
                          <span className="absolute inset-x-0 bottom-0 truncate bg-black/45 px-1.5 py-0.5 text-left text-[10px] text-white">
                            {item.label}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  <p className="mt-1 text-[length:var(--settings-desc-size)] text-(--ui-text-tertiary)">
                    当前：{currentBuiltin.label}。已选图片再点一次恢复第一张内置图。
                  </p>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-(--stroke-soft) px-3 py-2.5">
                  <div className="grid h-14 w-24 shrink-0 place-items-center rounded-md border border-(--stroke-soft) text-center text-[10px] text-(--ui-text-tertiary)">
                    自定义图片
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium">已选择本机图片</div>
                    <div className="truncate text-[length:var(--settings-desc-size)] text-(--ui-text-tertiary)">
                      {prefs.backdropImage}
                    </div>
                  </div>
                  <button
                    className="rounded-md border border-(--stroke-soft) px-2.5 py-1.5 text-xs text-(--ui-text-secondary)"
                    onClick={chooseCustomBackdrop}
                    type="button"
                  >
                    重新选择…
                  </button>
                  <button
                    className="flex items-center gap-1 rounded-md border border-(--stroke-soft) px-2.5 py-1.5 text-xs text-(--ui-text-secondary)"
                    onClick={() => prefs.setBackdropImage(BUILTIN_BACKDROPS[0].path)}
                    type="button"
                  >
                    <RotateCcw className="size-3" />
                    恢复默认
                  </button>
                </div>
              )}
            </div>
          ) : undefined
        }
        checked={prefs.backdrop}
        description="图片铺在每栏容器后面，栏的基础颜色保持不变；透明度档位控制图片透出多少。来源只有内置图片切换与自定义上传两种。"
        label="聊天背景"
        onChange={prefs.setBackdrop}
      />

      <ListRow
        action={
          <div className="flex items-center gap-3">
            <Slider
              aria-label="消息气泡"
              max={100}
              min={0}
              onChange={(event) => prefs.setUserBubbleTransparency(Number(event.target.value))}
              step={1}
              value={prefs.userBubbleTransparency}
            />
            <span className="w-9 text-right text-[length:var(--settings-desc-size)] tabular-nums text-(--ui-text-tertiary)">
              {prefs.userBubbleTransparency}%
            </span>
            <button
              className="rounded-md border border-(--stroke-soft) px-2 py-1 text-xs text-(--ui-text-secondary) disabled:opacity-40"
              disabled={prefs.userBubbleTransparency === 0}
              onClick={() => prefs.setUserBubbleTransparency(0)}
              type="button"
            >
              默认
            </button>
          </div>
        }
        description="你自己的消息有多透明。0 为不透明，100 时只保留边框。"
        title="消息气泡"
      />

      <ToggleRow
        checked={prefs.bubbleOutline}
        description="显示用户消息气泡的描边；关闭后只剩填充色。"
        label="消息气泡描边"
        onChange={prefs.setBubbleOutline}
      />
      </CardGroup>
    </div>
  )
}
