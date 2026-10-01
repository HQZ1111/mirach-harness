/* ZCode packages/ui/src/workspace-file-tree/WorkspaceFileTreeRowName.tsx 逐字拷贝
 * （压缩目录链 a/b/c 的斜杠分段渲染）。 */
import { Fragment } from "react";

export function WorkspaceFileTreeRowName({
  name,
  className,
  slashClassName,
}: {
  name: string;
  className?: string;
  slashClassName?: string;
}) {
  const segments = name.split("/");
  if (segments.length <= 1) {
    return <span className={className}>{name}</span>;
  }

  return (
    <span className={className}>
      {segments.map((segment, index) => (
        <Fragment key={`${segment}-${index}`}>
          {index > 0 ? <span className={slashClassName}>/</span> : null}
          <span>{segment}</span>
        </Fragment>
      ))}
    </span>
  );
}
