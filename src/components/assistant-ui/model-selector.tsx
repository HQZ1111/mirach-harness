"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  createContext,
  useContext,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCommandState } from "cmdk";
// 2026-10-16 换 beUI goo 弹层（用户定稿"所有 panel 型浮层"）——原 Radix
// ui/popover 的 API 面对位：方位/间距/圆角是 goo **根属性**（不是 content
// 属性），子组件从 context 读；content 支持 onOpenAutoFocus（键盘焦点契约）。
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/motion/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

export type ModelSelectorEffortOption = {
  id: string;
  name: string;
};

export const DEFAULT_EFFORT_OPTIONS: readonly ModelSelectorEffortOption[] = [
  { id: "low", name: "Low" },
  { id: "medium", name: "Med" },
  { id: "high", name: "High" },
];

export type ModelOption = {
  id: string;
  name: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
  /** Extra terms matched by ModelSelector.Search, in addition to id and name. */
  keywords?: readonly string[];
  /**
   * Reasoning effort levels the model supports. Pass `true` for the default
   * low/medium/high levels, or a custom list. Omit for models without
   * configurable reasoning.
   */
  efforts?: boolean | readonly ModelSelectorEffortOption[];
  /**
   * 分组键（provider）。同键的模型归到同一个分组标题下。
   *
   * 本地扩展（2026-10-26 用户："输入框里的模型怎么没有按名称分组显示，
   * 像 zcode 和 hermes 一样"）：上游 assistant-ui 的 ModelSelector 是扁平
   * 列表，ZCode / hermes 都是"按 provider 分组 + 组标题"。
   *
   * 省略时落到 `description`（宿主把它填成 provider 名），再不行用
   * `'其他'`——所以老调用点不改也自动分组。
   */
  group?: string;
};

function getModelEfforts(
  model: ModelOption | undefined,
): readonly ModelSelectorEffortOption[] | undefined {
  if (!model?.efforts) return undefined;
  return model.efforts === true ? DEFAULT_EFFORT_OPTIONS : model.efforts;
}

function resolveEffort(
  efforts: readonly ModelSelectorEffortOption[] | undefined,
  effort: string | undefined,
): string | undefined {
  if (effort === undefined) return undefined;
  return efforts?.some((e) => e.id === effort) ? effort : undefined;
}

/**
 * Returns the effort id if the given model supports it, otherwise undefined.
 * Effort selection is kept sticky across model switches; this resolves what
 * actually applies to the current model.
 */
export function resolveModelEffort(
  models: readonly ModelOption[],
  modelId: string | undefined,
  effort: string | undefined,
): string | undefined {
  return resolveEffort(
    getModelEfforts(models.find((m) => m.id === modelId)),
    effort,
  );
}

function useControllableState<T>({
  prop,
  defaultProp,
  onChange,
}: {
  prop: T | undefined;
  defaultProp: T | undefined;
  onChange: ((next: T) => void) | undefined;
}) {
  const [internal, setInternal] = useState(defaultProp);
  const isControlled = prop !== undefined;
  const value = isControlled ? prop : internal;
  // Read onChange through a ref so inline callbacks don't recreate the setter
  // (and with it the memoized context value) every render.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });
  const setValue = useCallback(
    (next: T) => {
      if (!isControlled) setInternal(next);
      onChangeRef.current?.(next);
    },
    [isControlled],
  );
  return [value, setValue] as const;
}

type ModelSelectorContextValue = {
  models: readonly ModelOption[];
  value: string | undefined;
  setValue: (value: string) => void;
  /** The model matching `value`, derived once for all sub-components. */
  selectedModel: ModelOption | undefined;
  /** The selected model's effort levels, undefined when not configurable. */
  efforts: readonly ModelSelectorEffortOption[] | undefined;
  /** Effort resolved against the selected model's supported levels. */
  effort: string | undefined;
  setEffort: (effort: string) => void;
  setOpen: (open: boolean) => void;
};

const ModelSelectorContext = createContext<ModelSelectorContextValue | null>(
  null,
);

export function useModelSelectorContext() {
  const ctx = useContext(ModelSelectorContext);
  if (!ctx) {
    throw new Error(
      "ModelSelector sub-components must be used within ModelSelector.Root",
    );
  }
  return ctx;
}

/**
 * The selected model's effort levels and the active selection. Use it to build
 * a custom effort UI inside ModelSelector.Content (e.g. a slider or a shadcn
 * DropdownMenu) when the built-in ModelSelector.Effort layout doesn't fit.
 * `efforts` is undefined for models without configurable reasoning.
 */
export function useModelSelectorEfforts(): {
  efforts: readonly ModelSelectorEffortOption[] | undefined;
  effort: string | undefined;
  setEffort: (effort: string) => void;
} {
  const { efforts, effort, setEffort } = useModelSelectorContext();
  return { efforts, effort, setEffort };
}

export type ModelSelectorRootProps = {
  models: readonly ModelOption[];
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  effort?: string;
  defaultEffort?: string;
  onEffortChange?: (effort: string) => void;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** 面板方位（goo 根属性——2026-10-16 换 beUI goo 弹层时从 content 上提）。 */
  side?: "top" | "bottom";
  /** 面板沿触发边对齐（同上）。 */
  align?: "start" | "center" | "end";
  /** 触发边与面板的间距 px（goo 的"脖子"长度；同上）。 */
  sideOffset?: number;
  children: ReactNode;
};

function ModelSelectorRoot({
  models,
  value: valueProp,
  defaultValue,
  onValueChange,
  effort: effortProp,
  defaultEffort,
  onEffortChange,
  open: openProp,
  defaultOpen,
  onOpenChange,
  side,
  align,
  sideOffset,
  children,
}: ModelSelectorRootProps) {
  const [value, setValue] = useControllableState({
    prop: valueProp,
    defaultProp: defaultValue ?? models[0]?.id,
    onChange: onValueChange,
  });
  const [effort, setEffort] = useControllableState({
    prop: effortProp,
    defaultProp: defaultEffort,
    onChange: onEffortChange,
  });
  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
  });

  const selectedModel = models.find((m) => m.id === value);
  const efforts = getModelEfforts(selectedModel);
  const activeEffort = resolveEffort(efforts, effort);
  const contextValue = useMemo(
    () => ({
      models,
      value,
      setValue,
      selectedModel,
      efforts,
      effort: activeEffort,
      setEffort,
      setOpen,
    }),
    [
      models,
      value,
      setValue,
      selectedModel,
      efforts,
      activeEffort,
      setEffort,
      setOpen,
    ],
  );

  return (
    <ModelSelectorContext.Provider value={contextValue}>
      {/* 方位/对齐/间距（beUI API；content 侧不再接受）。
          goo 已退役（2026-11-22）：弹层 = 默认 fade+zoom 的独立圆角矩形
          + 投影，触发钮（输入框下方的模型胶囊）不再有副本/脖子/投影。 */}
      <Popover
        align={align ?? "start"}
        open={open ?? false}
        onOpenChange={setOpen}
        side={side ?? "bottom"}
        sideOffset={sideOffset ?? 14}
      >
        {children}
      </Popover>
    </ModelSelectorContext.Provider>
  );
}

export const modelSelectorTriggerVariants = cva(
  "pressable-sm focus-visible:ring-ring/50 flex w-fit items-center justify-between gap-2 overflow-hidden rounded-md text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-1 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        outline:
          "border-input hover:bg-accent hover:text-accent-foreground border bg-transparent",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        muted: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
      },
      size: {
        default: "h-9 px-3 py-2",
        sm: "h-8 px-2.5 py-1.5 text-xs",
        lg: "h-10 px-4 py-2.5",
      },
    },
    defaultVariants: {
      variant: "outline",
      size: "default",
    },
  },
);

export type ModelSelectorTriggerProps = Omit<
  ComponentPropsWithoutRef<"button">,
  "children"
> &
  VariantProps<typeof modelSelectorTriggerVariants> & {
    children?: ReactNode;
  };

function ModelSelectorTrigger({
  className,
  variant,
  size,
  children,
  onKeyDown,
  ...props
}: ModelSelectorTriggerProps) {
  const { setOpen } = useModelSelectorContext();

  // goo PopoverTrigger 吃**单个元素子节点**（克隆载体）——子元素 = 裸
  // 按钮壳，属性全走 PopoverTrigger 的 rest 合并（clone 里 cn("relative
  // z-0", childProps.className, rest.className) 与 ...rest 展开）。
  // 对位 Radix asChild 语义（原版直接塞多子节点，此处显式收进一个按钮）。
  return (
    <PopoverTrigger
      aria-haspopup="listbox"
      className={cn(modelSelectorTriggerVariants({ variant, size }), className)}
      data-size={size ?? "default"}
      data-slot="model-selector-trigger"
      data-variant={variant ?? "outline"}
      onKeyDown={(e: React.KeyboardEvent<HTMLButtonElement>) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        // ARIA combobox: arrows open the listbox from a focused trigger.
        // Popover leaves this to the consumer.
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          setOpen(true);
        }
      }}
      role="combobox"
      type="button"
      {...props}
    >
      <button type="button">
        {children ?? <ModelSelectorValue />}
        <ChevronDownIcon className="size-[var(--size-icon-lg)] opacity-50" />
      </button>
    </PopoverTrigger>
  );
}

export type ModelSelectorValueProps = {
  placeholder?: ReactNode;
  /** Show the active effort level next to the model name. */
  showEffort?: boolean;
  className?: string;
};

function ModelIcon({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-3.5",
        className,
      )}
    >
      {children}
    </span>
  );
}

function ModelSelectorValue({
  placeholder = "Select model",
  showEffort = true,
  className,
}: ModelSelectorValueProps) {
  const { selectedModel, efforts, effort } = useModelSelectorContext();

  if (!selectedModel) {
    return (
      <span
        data-slot="model-selector-value"
        className={cn("text-muted-foreground truncate", className)}
      >
        {placeholder}
      </span>
    );
  }

  const effortName =
    showEffort && effort !== undefined
      ? efforts?.find((e) => e.id === effort)?.name
      : undefined;

  return (
    <span
      data-slot="model-selector-value"
      className={cn("flex min-w-0 items-center gap-2", className)}
    >
      {selectedModel.icon && <ModelIcon>{selectedModel.icon}</ModelIcon>}
      <span className="truncate font-medium">{selectedModel.name}</span>
      {effortName && (
        /* 窄 composer（@max-xl/composer = 卡片 < 36rem）只留模型名：思考
           档位是长文本里最先让位的——ZCode 在卡片窄于 36rem 时就是只显示
           图标/名称（ThoughtLevelCycleControl / ConfigSelect 的 label
           可见性规则）。这里用容器查询由 CSS 决定，不引入 JS 测量。 */
        <span
          data-slot="model-selector-effort"
          className="text-muted-foreground min-w-7.5 truncate text-center @max-xl/composer:hidden"
        >
          {effortName}
        </span>
      )}
    </span>
  );
}

export type ModelSelectorContentProps = Omit<
  ComponentPropsWithoutRef<typeof PopoverContent>,
  "children"
> & {
  searchable?: boolean;
  /** 面板内容（缺省 = 内置 搜索/列表/Effort 组合）。 */
  children?: ReactNode;
};

/**
 * Hidden input that anchors cmdk's keyboard navigation, keeping the list
 * keyboard-operable without a visible search box. ModelSelectorContent renders
 * one automatically when unfiltered.
 *
 * **不要用 `CommandInput`**：它自带 InputGroup 外壳（搜索图标 + 边框 +
 * `h-9`），`sr-only` 只把外层 div 裁成 1px，里面的框仍然参与布局/绘制——
 * 实测面板顶部会多出一条带搜索图标的空行（用户："显示的不一样"）。
 * 这里直接渲染 cmdk 的 `<input cmdk-input>`，`sr-only` 就能完整生效。
 */
function ModelSelectorFocusAnchor() {
  return (
    <div className="sr-only">
      <input aria-label="Model" cmdk-input="" readOnly type="text" />
    </div>
  );
}

function ModelSelectorContent({
  className,
  searchable,
  children,
  ...props
}: ModelSelectorContentProps) {
  const { value } = useModelSelectorContext();
  const unfiltered =
    searchable === false || (!searchable && children === undefined);

  return (
    <PopoverContent
      data-slot="model-selector-content"
      className={cn(
        // 宽度对位旧 Radix 版（w-72）；宽度变量退路保留（goo 无
        // --radix-popover-trigger-width，回退 18rem）。
        "bg-popover w-72 overflow-hidden rounded-xl p-0",
        className,
      )}
      // 键盘可用性（对位原 Radix 默认开面板 autofocus）：焦点进 cmdk
      // 输入框（searchable = 搜索框；否则 = sr-only readOnly 锚），
      // ↑↓/Enter 才能驱动 cmdk。调用方传 onOpenAutoFocus 可整体接管
      // （{...props} 在 JSX 序上覆盖此默认）。
      onOpenAutoFocus={(el) => {
        el.querySelector("input")?.focus();
      }}
      {...props}
    >
      <Command
        className="bg-transparent"
        // **必须开过滤**（2026-10-26 改）：`shouldFilter={false}` 时 cmdk
        // 不维护 `state.search`，`CommandInput` 的 onChange 只调外部回调——
        // 于是"打字搜索"对列表毫无作用，分组折叠也不知道该展开哪一组
        // （实测：输入 claude 后 72 项原样全在）。
        //
        // 隐藏输入锚（`ModelSelectorFocusAnchor`）仍走 `readOnly`，它的
        // value 恒为空 → 过滤不生效，键盘导航照旧可用（cmdk 的 ↑↓ 走
        // `[cmdk-item]:not([aria-disabled])`，与过滤无关）。
        shouldFilter
        {...(value !== undefined ? { defaultValue: value } : {})}
      >
        {unfiltered && <ModelSelectorFocusAnchor />}
        {children ?? (
          <>
            {searchable && <ModelSelectorSearch />}
            <ModelSelectorList />
            <ModelSelectorEffort />
          </>
        )}
      </Command>
    </PopoverContent>
  );
}

export type ModelSelectorSearchProps = ComponentPropsWithoutRef<
  typeof CommandInput
>;

function ModelSelectorSearch({
  placeholder = "Search models...",
  ...props
}: ModelSelectorSearchProps) {
  return (
    <CommandInput
      data-slot="model-selector-search"
      placeholder={placeholder}
      {...props}
    />
  );
}

export type ModelSelectorListProps = ComponentPropsWithoutRef<
  typeof CommandList
>;

function ModelSelectorList({
  className,
  children,
  ...props
}: ModelSelectorListProps) {
  const { models, value } = useModelSelectorContext();
  // cmdk 的搜索态。**只有 `searchable` 面板才有搜索框**（默认 composer 的
  // 模型选择器是 `sr-only readOnly` 锚，永远不会有 search）——此时分组全部
  // 展开，否则"搜到了但分组收着"会让人以为没有结果。
  const search = useCommandState((state) => state.search);
  const filteredCount = useCommandState((state) => state.filtered.count);
  const searching = search.trim().length > 0;

  // 按分组键聚合（保持首次出现顺序——pi_list_models 是稳定的目录序，
  // 打乱会让用户每次打开看到不同顺序）。
  //
  // 2026-10-26 用户："输入框里的模型怎么没有按名称分组显示，像 zcode 和
  // hermes 一样" → 按 provider 分组；随后："显示的不一样，不能折叠啊" →
  // 分组必须可折叠，否则 72 项照样一屏铺满（分组只是多了三行标题）。
  //
  // 折叠语义对齐 ZCode 的 `ModelConfigSelect`（顶层只有 provider，模型收在
  // 里面）：默认只展开**当前选中模型所在的那一组**，其余收起；点组标题切换。
  const groups = useMemo(() => {
    const byKey = new Map<string, { label: string; items: ModelOption[] }>();
    for (const model of models) {
      const key = model.group ?? model.description ?? '其他';
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, { label: key, items: [model] });
      } else {
        existing.items.push(model);
      }
    }
    return [...byKey.entries()].map(([key, value]) => ({ key, ...value }));
  }, [models]);

  // 展开态：默认 = 选中模型所在组。用 Set 记住用户手动展开的组（多组同时
  // 展开是合理操作——用户可能在比较两家的模型）。
  const selectedGroupKey = useMemo(() => {
    if (value === undefined) return groups[0]?.key;
    return groups.find((group) => group.items.some((m) => m.id === value))?.key;
  }, [groups, value]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(selectedGroupKey === undefined ? [] : [selectedGroupKey]),
  );
  // 选中模型变化时把它所在组补进展开集（切换模型后重开面板能直接看到它）。
  useEffect(() => {
    if (selectedGroupKey === undefined) return;
    setExpanded((current) =>
      current.has(selectedGroupKey) ? current : new Set([...current, selectedGroupKey]),
    );
  }, [selectedGroupKey]);

  const toggleGroup = useCallback((key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // 空态：目录真的为空，或"搜索中且一条都没匹配"。
  //
  // **不能在收起的组上也报空**：cmdk 的 CommandEmpty 看 `filtered.count`，
  // 而收起的组我们整组不渲染（不渲染才能让 ↑↓ 只走可见项），count 自然为 0
  // ——那样一进面板就是"没有匹配的模型"。
  const showEmpty =
    models.length === 0 || (searching && filteredCount === 0);

  return (
    <CommandList
      data-slot="model-selector-list"
      className={cn(
        "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          {showEmpty && <ModelSelectorEmpty />}
          {groups.map((group) => {
            const isOpen = searching || expanded.has(group.key);
            const groupSelected = group.items.some((m) => m.id === value);
            return (
              <CommandGroup
                data-slot="model-selector-group"
                key={group.key}
              >
                {/* 组标题 = 折叠开关（ZCode 的 provider 行同款：一行只显示
                    provider 名 + 模型数，模型收在里面）。 */}
                <button
                  aria-expanded={isOpen}
                  className="set-model-group-head"
                  data-group-selected={groupSelected ? 'true' : undefined}
                  data-slot="model-selector-group-head"
                  disabled={searching}
                  onClick={() => toggleGroup(group.key)}
                  type="button"
                >
                  <ChevronRightIcon
                    aria-hidden
                    className={cn(
                      'set-model-group-chevron',
                      isOpen && 'set-model-group-chevron--open',
                    )}
                  />
                  <span className="set-model-group-label">{group.label}</span>
                  {groupSelected && !isOpen && (
                    <span className="set-model-group-current">
                      {group.items.find((m) => m.id === value)?.name}
                    </span>
                  )}
                  <span className="set-model-group-count">{group.items.length}</span>
                </button>
                {/* 收起的组整组不渲染：cmdk 的 ↑↓ 走的是全部 `[cmdk-item]`
                    （不分可见性），渲染了隐藏项会让键盘跳到看不见的行上。 */}
                {isOpen &&
                  group.items.map((model) => (
                    <ModelSelectorItem
                      key={model.id}
                      model={model}
                      // 分组后每项下面的 provider 副标题是重复信息（整组都是
                      // 同一个 provider），只在未分组时显示。
                      showDescription={false}
                    />
                  ))}
              </CommandGroup>
            );
          })}
        </>
      )}
    </CommandList>
  );
}

export type ModelSelectorEmptyProps = ComponentPropsWithoutRef<
  typeof CommandEmpty
>;

function ModelSelectorEmpty({ children, ...props }: ModelSelectorEmptyProps) {
  return (
    <CommandEmpty data-slot="model-selector-empty" {...props}>
      {children ?? "No models found."}
    </CommandEmpty>
  );
}

export type ModelSelectorGroupProps = ComponentPropsWithoutRef<
  typeof CommandGroup
>;

function ModelSelectorGroup(props: ModelSelectorGroupProps) {
  return <CommandGroup data-slot="model-selector-group" {...props} />;
}

export type ModelSelectorSeparatorProps = ComponentPropsWithoutRef<
  typeof CommandSeparator
>;

function ModelSelectorSeparator(props: ModelSelectorSeparatorProps) {
  return <CommandSeparator data-slot="model-selector-separator" {...props} />;
}

export type ModelSelectorItemProps = Omit<
  ComponentPropsWithoutRef<typeof CommandItem>,
  "value"
> & {
  model: ModelOption;
  /**
   * 是否显示 provider 副标题。分组渲染时传 `false`——整组同一个 provider，
   * 每行再写一遍是纯重复（ZCode 的模型项也只显示模型名）。
   */
  showDescription?: boolean;
};

function ModelSelectorItem({
  model,
  className,
  children,
  onSelect,
  showDescription = true,
  ...props
}: ModelSelectorItemProps) {
  const { value, setValue, setOpen } = useModelSelectorContext();
  const isSelected = value === model.id;

  return (
    <CommandItem
      data-slot="model-selector-item"
      value={model.id}
      keywords={[model.name, ...(model.keywords ?? [])]}
      {...(model.disabled ? { disabled: true } : undefined)}
      onSelect={(selectedValue) => {
        setValue(model.id);
        setOpen(false);
        onSelect?.(selectedValue);
      }}
      className={cn(
        "relative items-start gap-2 rounded-lg py-2 ps-3 pe-9 [&_svg:not([class*='size-'])]:size-3.5",
        className,
      )}
      {...props}
    >
      {children ?? (
        <>
          {model.icon && (
            <ModelIcon className="mt-[3px]">{model.icon}</ModelIcon>
          )}
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{model.name}</span>
            {showDescription && model.description && (
              <span className="text-muted-foreground truncate text-xs">
                {model.description}
              </span>
            )}
          </span>
        </>
      )}
      {isSelected && (
        <span className="absolute end-3 top-2.5 flex size-4 items-center justify-center">
          <CheckIcon className="size-[var(--size-icon-lg)]" />
        </span>
      )}
    </CommandItem>
  );
}

export type ModelSelectorEffortProps = ComponentPropsWithoutRef<"div"> & {
  label?: ReactNode;
};

function ModelSelectorEffort({
  label = "Thinking",
  className,
  onKeyDown,
  ...props
}: ModelSelectorEffortProps) {
  const { efforts, effort, setEffort } = useModelSelectorEfforts();

  if (!efforts?.length) return null;

  return (
    <div
      data-slot="model-selector-effort"
      className={cn(
        "flex cursor-default items-center justify-between gap-3 border-t px-3 py-2",
        className,
      )}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (e.defaultPrevented) return;
        // cmdk's Command root claims Home/End to jump the model list; stop
        // them here so only the radiogroup reacts.
        if (e.key === "Home" || e.key === "End") e.stopPropagation();
        // Vertical arrows refocus cmdk's input before the event bubbles to
        // the Command root: the same keypress then moves the list highlight,
        // and Enter selects again (cmdk's Enter is inert while a radio has
        // focus, so the highlight would otherwise move with no way to act).
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.currentTarget
            .closest("[cmdk-root]")
            ?.querySelector<HTMLInputElement>("[cmdk-input]")
            ?.focus();
        }
      }}
      {...props}
    >
      <span className="text-muted-foreground text-xs">{label}</span>
      <RadioGroupPrimitive.Root
        value={effort ?? ""}
        onValueChange={setEffort}
        orientation="horizontal"
        aria-label={typeof label === "string" ? label : "Reasoning effort"}
        className="flex items-center gap-0.5"
      >
        {efforts.map((option) => (
          <RadioGroupPrimitive.Item
            key={option.id}
            value={option.id}
            className={cn(
              "focus-visible:ring-ring/50 text-muted-foreground hover:bg-(--hover-wash) hover:text-foreground cursor-pointer rounded-md px-2 py-1 text-xs transition-colors outline-none focus-visible:ring-1",
              "data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground data-[state=checked]:font-medium",
            )}
          >
            {option.name}
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
    </div>
  );
}

export type ModelSelectorProps = Omit<ModelSelectorRootProps, "children"> &
  VariantProps<typeof modelSelectorTriggerVariants> & {
    /** Render a search input above the model list. */
    searchable?: boolean;
    /** Alignment of the dropdown relative to the trigger. Use `"end"` when the
     * trigger sits at the right edge of its container.（goo 的 align 是根属性
     * ——ModelSelectorImpl 透传给 Root） */
    align?: ModelSelectorRootProps["align"];
    className?: string;
    contentClassName?: string;
  };

export {
  ModelSelectorRoot,
  ModelSelectorTrigger,
  ModelSelectorValue,
  ModelSelectorContent,
  ModelSelectorSearch,
  ModelSelectorFocusAnchor,
  ModelSelectorList,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorSeparator,
  ModelSelectorItem,
  ModelSelectorEffort,
};
