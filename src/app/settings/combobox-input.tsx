import { type ReactNode, useId, useRef, useState } from 'react'

import { isSubmitEnter } from '@/components/panes/session-manage/ime'
import { Codicon } from '@/components/ui/codicon'
import { Command, CommandItem, CommandItemCheck, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

// hermes `app/settings/combobox-input.tsx` 复制（只把 i18n 的按钮文案写死为
// 简体中文，其余逻辑逐行一致）：自由输入 + 完整候选菜单；不用 `<datalist>`
// （Chromium 原生灰弹层与全局菜单不一致，且按当前值过滤）。
const IDLE = '\u0000idle'

export function ComboboxInput({
  'aria-label': ariaLabel,
  className,
  disabled,
  onChange,
  optionLabels,
  options,
  placeholder,
  renderOption,
  value
}: {
  'aria-label'?: string
  className?: string
  disabled?: boolean
  onChange: (value: string) => void
  optionLabels?: Record<string, string>
  options: readonly string[]
  placeholder?: string
  renderOption?: (option: string) => ReactNode
  value: string
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(IDLE)
  const anchorRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const commandRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  const query = value.trim().toLowerCase()
  const isExact = options.some((option) => option.toLowerCase() === query)
  const visible = query && !isExact ? options.filter((option) => option.toLowerCase().includes(query)) : options
  const expanded = open && !disabled && visible.length > 0

  const openList = (next: boolean) => {
    setOpen(next)
    setActive(IDLE)
  }

  const forwardKey = (key: string) =>
    commandRef.current?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key }))

  return (
    <Popover onOpenChange={openList} open={expanded}>
      <PopoverAnchor asChild>
        <div className={cn('relative', className)} ref={anchorRef}>
          <Input
            aria-autocomplete="list"
            aria-controls={expanded ? listId : undefined}
            aria-expanded={expanded}
            aria-label={ariaLabel}
            className="w-full pr-7"
            disabled={disabled}
            onChange={(e) => {
              onChange(e.target.value)
              openList(true)
            }}
            onFocus={() => openList(true)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                if (expanded) forwardKey(e.key)
                else openList(true)
                return
              }
              if (isSubmitEnter(e) && expanded && active !== IDLE) {
                e.preventDefault()
                forwardKey('Enter')
                return
              }
              if (e.key === 'Escape' || e.key === 'Tab' || isSubmitEnter(e)) {
                openList(false)
              }
            }}
            placeholder={placeholder}
            ref={inputRef}
            role="combobox"
            value={value}
          />
          <button
            aria-label="显示选项"
            className="absolute inset-y-0 right-1.5 flex items-center text-(--ui-text-tertiary) disabled:opacity-50"
            disabled={disabled}
            onClick={() => {
              openList(!expanded)
              inputRef.current?.focus()
            }}
            tabIndex={-1}
            type="button"
          >
            <Codicon name={expanded ? 'chevron-up' : 'chevron-down'} size="1rem" />
          </button>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="z-[calc(var(--z-modal)+10)] min-w-(--radix-popover-trigger-width) p-1"
        onInteractOutside={(e) => {
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault()
        }}
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command onValueChange={setActive} ref={commandRef} shouldFilter={false} value={active}>
          <CommandList id={listId}>
            {visible.map((option) => (
              <CommandItem
                key={option}
                onSelect={() => {
                  onChange(option)
                  openList(false)
                }}
                value={option}
              >
                <span className="min-w-0 truncate">{renderOption?.(option) ?? optionLabels?.[option] ?? option}</span>
                <CommandItemCheck checked={option === value} />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
