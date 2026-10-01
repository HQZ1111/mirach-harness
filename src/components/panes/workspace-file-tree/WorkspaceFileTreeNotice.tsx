/* ZCode packages/ui/src/workspace-file-tree/WorkspaceFileTreeNotice.tsx 拷贝；
 * 语义色换 harness tokens.css 令牌（foreground-subtle → --text-2，
 * foreground-subtlest → --text-3）。 */
import type { ReactNode } from "react";

export function WorkspaceFileTreeNotice({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center gap-2 px-4 text-center text-(--filetree-row-font-size) text-(--text-2)">
      <div className="text-(--text-3)">{icon}</div>
      <div className="font-medium text-(--text-2)">{title}</div>
      {description ? (
        <div className="max-w-full break-words text-(--text-3)">{description}</div>
      ) : null}
    </div>
  );
}
