"use client";

import { memo, useEffect } from "react";
import { useAui } from "@assistant-ui/react";
import {
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
  useModelSelectorContext,
  type ModelSelectorProps,
} from "./model-selector";

export {
  DEFAULT_EFFORT_OPTIONS,
  modelSelectorTriggerVariants,
  resolveModelEffort,
  useModelSelectorEfforts,
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
} from "./model-selector";

export type {
  ModelOption,
  ModelSelectorEffortOption,
  ModelSelectorProps,
  ModelSelectorRootProps,
  ModelSelectorTriggerProps,
  ModelSelectorValueProps,
  ModelSelectorContentProps,
  ModelSelectorSearchProps,
  ModelSelectorListProps,
  ModelSelectorEmptyProps,
  ModelSelectorGroupProps,
  ModelSelectorSeparatorProps,
  ModelSelectorItemProps,
  ModelSelectorEffortProps,
} from "./model-selector";

/** Registers the selection with assistant-ui's ModelContext system. The
 * context's effort is already resolved against the selected model. */
function ModelSelectorModelContext() {
  const { value, effort } = useModelSelectorContext();
  const api = useAui();

  useEffect(() => {
    if (value === undefined) return;
    const config = {
      config: {
        modelName: value,
        ...(effort !== undefined ? { reasoningEffort: effort } : undefined),
      },
    };
    return api.modelContext.register({
      getModelContext: () => config,
    });
  }, [api, value, effort]);

  return null;
}

const ModelSelectorImpl = ({
  searchable,
  variant,
  size,
  align,
  className,
  contentClassName,
  ...rootProps
}: ModelSelectorProps) => {
  // align 是 Root 级属性（2026-10-16 换 Popover 时从 content 上提；本组件从
  // rootProps 摘出 align 显式传给 Root）。
  const { align: _align, ...rest } = rootProps as typeof rootProps & {
    align?: "start" | "center" | "end";
  };
  return (
    <ModelSelectorRoot {...rest} align={align ?? _align}>
      <ModelSelectorModelContext />
      <ModelSelectorTrigger
        variant={variant}
        size={size}
        className={className}
      />
      <ModelSelectorContent
        className={contentClassName}
        searchable={searchable ?? false}
      />
    </ModelSelectorRoot>
  );
};

type ModelSelectorComponent = typeof ModelSelectorImpl & {
  displayName?: string;
  Root: typeof ModelSelectorRoot;
  Trigger: typeof ModelSelectorTrigger;
  Value: typeof ModelSelectorValue;
  Content: typeof ModelSelectorContent;
  Search: typeof ModelSelectorSearch;
  FocusAnchor: typeof ModelSelectorFocusAnchor;
  List: typeof ModelSelectorList;
  Empty: typeof ModelSelectorEmpty;
  Group: typeof ModelSelectorGroup;
  Separator: typeof ModelSelectorSeparator;
  Item: typeof ModelSelectorItem;
  Effort: typeof ModelSelectorEffort;
};

const ModelSelector = memo(
  ModelSelectorImpl,
) as unknown as ModelSelectorComponent;

ModelSelector.displayName = "ModelSelector";
ModelSelector.Root = ModelSelectorRoot;
ModelSelector.Trigger = ModelSelectorTrigger;
ModelSelector.Value = ModelSelectorValue;
ModelSelector.Content = ModelSelectorContent;
ModelSelector.Search = ModelSelectorSearch;
ModelSelector.FocusAnchor = ModelSelectorFocusAnchor;
ModelSelector.List = ModelSelectorList;
ModelSelector.Empty = ModelSelectorEmpty;
ModelSelector.Group = ModelSelectorGroup;
ModelSelector.Separator = ModelSelectorSeparator;
ModelSelector.Item = ModelSelectorItem;
ModelSelector.Effort = ModelSelectorEffort;

export { ModelSelector };
