/* ZCode packages/ui/src/workspace-file-tree/helpers.ts 拷贝（2026-10-01）。
 * 只留两纯函数；openWith/fileManager 标签类助手依赖平台服务，未随（工程无
 * 对应 IPC），取舍见报告。 */

export function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

export function replaceSetValue(set: Set<string>, value: string, present: boolean): Set<string> {
  const next = new Set(set)
  if (present) {
    next.add(value)
  } else {
    next.delete(value)
  }
  return next
}
