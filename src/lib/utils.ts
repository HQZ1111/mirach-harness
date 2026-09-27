import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

/** shadcn/registry 组件的类名合并器（CLI 组件依赖此导出） */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
